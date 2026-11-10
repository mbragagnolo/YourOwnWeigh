/** Live forecast for the Body Smart (WBS13) weather screen.
 *
 * Wire format and behaviour traced in stock firmware 1311 (see
 * firmware/wbs13/v1311/README.md, "Weather Screen"):
 *
 * - The scale requests `/v2/weather` only when a user's screen list holds
 *   embedded screen 10 (weather) or 21 (air quality).
 * - It parses `body.series.w[]` entries `{ti, te, ic}` into eight slots keyed
 *   by `ti` (epoch seconds, on the hour). `te` is whole degrees Celsius (the
 *   scale converts to Fahrenheit itself) and `ic` selects one of its icons.
 * - The screen shows two forecasts, "AM" (06:00) and "PM" (12:00), for today,
 *   or for tomorrow once its clock passes 18:59.
 *
 * - `body.series.aq[]` entries `{ti, aqi}` fill the same slots for the air
 *   quality screen (21), which shows the mean of the AM and PM values on a
 *   gauge with steps at 20, 50 and 100, capped at 200. A slot whose `aqi` reads
 *   negative as a signed 16-bit value is treated as missing.
 *
 * Whether the scale's hour is derived from UTC or from the session's time
 * offset is not established, so each forecast is sent under both readings of
 * 06:00/12:00. That is 2 hours x 2 days x 2 readings = the eight slots.
 */

export interface WeatherEnv {
  /** Body Smart result pages, in order; see wbs13Screens(). */
  YOW_WBS13_SCREENS?: string;
  YOW_WEATHER_LATITUDE?: string;
  YOW_WEATHER_LONGITUDE?: string;
  weatherFetch?: typeof fetch;
}
export type WeatherEntry = { ti: number; te: number; ic: number };
export type AirEntry = { ti: number; aqi: number };
export type Forecast = { w: WeatherEntry[]; aq?: AirEntry[] };
/** Stored by the scale as 0xFFFF, which its air quality screen skips. */
export const NO_AQI = 65535;
export type WeatherPlace = { latitude: number; longitude: number };

const FRESH_MS = 30 * 60_000;
const STALE_MS = 6 * 3600_000;
const TIMEOUT_MS = 6000;
const HOURS = ["06", "12"];
const cache = new Map<string, { at: number; entries: Forecast }>();
const pending = new Map<string, Promise<Forecast | null>>();

/** The configured place, rounded to about a kilometre so the forecast provider
 * never receives a precise address. Null when unset or invalid. */
export function weatherPlace(env: WeatherEnv): WeatherPlace | null {
  const raw = [env.YOW_WEATHER_LATITUDE, env.YOW_WEATHER_LONGITUDE];
  if (raw.some((v) => typeof v !== "string" || !/^-?\d{1,3}(\.\d+)?$/.test(v.trim())))
    return null;
  const [latitude, longitude] = raw.map((v) => Math.round(Number(v) * 100) / 100);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/** WMO weather code to the scale's icon. Icons 1 (sun), 3 (cloud) and 4 (sun
 * behind cloud) and the fallback image used for any other value (cloud with
 * rain) were identified from the firmware bitmaps. Icon 5 appears to be a
 * lightning bolt; icon 2 is unidentified and unused. */
export function weatherIcon(code: number): number {
  if (code === 0) return 1;
  if (code === 1 || code === 2) return 4;
  if (code === 3 || code === 45 || code === 48) return 3;
  if (code >= 95) return 5;
  return 6;
}

/** Values for the scale's slots from an Open-Meteo hourly reply requested
 * with a named time zone (local ISO times plus `utc_offset_seconds`). `pick`
 * returns the slot's fields for hourly index `i`, or null to skip it. */
function slots<T extends object>(
  reply: unknown,
  pick: (hourly: Record<string, unknown[]>, i: number) => T | null,
): Array<T & { ti: number }> {
  const r = reply as {
    utc_offset_seconds?: unknown;
    hourly?: Record<string, unknown>;
  };
  const hourly = r?.hourly,
    offset = r?.utc_offset_seconds;
  if (
    !hourly ||
    typeof hourly !== "object" ||
    !Object.values(hourly).every(Array.isArray) ||
    !Array.isArray(hourly.time) ||
    typeof offset !== "number" ||
    !Number.isInteger(offset)
  )
    return [];
  const bySlot = new Map<number, T & { ti: number }>();
  const days = new Set<string>();
  (hourly.time as unknown[]).forEach((time, i) => {
    const m =
      typeof time === "string" &&
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00$/.exec(time);
    if (!m || !HOURS.includes(m[4])) return;
    days.add((time as string).slice(0, 10));
    if (days.size > 2) return;
    const entry = pick(hourly as Record<string, unknown[]>, i);
    if (!entry) return;
    // The local wall-clock hour read as if it were UTC, and the true instant.
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) / 1000;
    bySlot.set(wall, { ti: wall, ...entry });
    // Slots must fall on the hour; skip the true instant for half-hour zones.
    if (offset % 3600 === 0 && !bySlot.has(wall - offset))
      bySlot.set(wall - offset, { ti: wall - offset, ...entry });
  });
  return [...bySlot.values()].sort((a, b) => a.ti - b.ti).slice(0, 8);
}

/** Weather slots from an Open-Meteo forecast reply. */
export function weatherSeries(reply: unknown): WeatherEntry[] {
  return slots(reply, (hourly, i) => {
    const te = hourly.temperature_2m?.[i],
      code = hourly.weather_code?.[i];
    return typeof te === "number" && typeof code === "number"
      ? { te: Math.round(te), ic: weatherIcon(code) }
      : null;
  });
}

/** Air quality slots from an Open-Meteo air-quality reply. The European AQI
 * shares the scale's first step (20 = good) and is sent unconverted. */
export function airSeries(reply: unknown): AirEntry[] {
  return slots(reply, (hourly, i) => {
    const aqi = hourly.european_aqi?.[i];
    return typeof aqi === "number" && aqi >= 0
      ? { aqi: Math.min(Math.round(aqi), 500) }
      : null;
  });
}

/** Forecast slots for a place, cached for half an hour. Returns null when the
 * weather provider cannot be reached and nothing recent is cached. With `air`
 * it also carries air quality; if only that lookup fails, every weather slot
 * gets the "missing" value so the scale skips its air quality screen instead
 * of showing a stale or zero reading. Never throws. Concurrent callers share
 * one request, so a session can start the lookup before the scale asks. */
export function forecast(
  env: WeatherEnv,
  place: WeatherPlace,
  timeZone: string | null,
  air = false,
): Promise<Forecast | null> {
  const zone = timeZone || "auto";
  const key = `${place.latitude},${place.longitude},${zone},${air}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS)
    return Promise.resolve(cached.entries);
  let request = pending.get(key);
  if (!request) {
    request = load(env, place, zone, air, key).finally(() =>
      pending.delete(key),
    );
    pending.set(key, request);
  }
  return request;
}

async function hourly(
  env: WeatherEnv,
  base: string,
  place: WeatherPlace,
  zone: string,
  fields: string,
): Promise<unknown> {
  const url = new URL(base);
  url.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    hourly: fields,
    timezone: zone,
    forecast_days: "2",
  }).toString();
  const response = await (env.weatherFetch ?? fetch)(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`forecast HTTP ${response.status}`);
  return response.json();
}

async function load(
  env: WeatherEnv,
  place: WeatherPlace,
  zone: string,
  air: boolean,
  key: string,
): Promise<Forecast | null> {
  const cached = cache.get(key);
  try {
    const [weather, quality] = await Promise.all([
      hourly(
        env,
        "https://api.open-meteo.com/v1/forecast",
        place,
        zone,
        "temperature_2m,weather_code",
      ),
      air
        ? hourly(
            env,
            "https://air-quality-api.open-meteo.com/v1/air-quality",
            place,
            zone,
            "european_aqi",
          ).catch(() => null)
        : null,
    ]);
    const w = weatherSeries(weather);
    if (!w.length) throw new Error("forecast reply had no usable hours");
    const entries: Forecast = { w };
    if (air) {
      const known = new Map(
        airSeries(quality).map((entry) => [entry.ti, entry.aqi]),
      );
      entries.aq = w.map(({ ti }) => ({ ti, aqi: known.get(ti) ?? NO_AQI }));
    }
    cache.set(key, { at: Date.now(), entries });
    return entries;
  } catch {
    return cached && Date.now() - cached.at < STALE_MS ? cached.entries : null;
  }
}

/** Test hook: forget cached forecasts. */
export const clearWeatherCache = () => {
  cache.clear();
  pending.clear();
};

/** Embedded screen IDs of the Body Smart result pages (firmware 1311). */
export const WBS13_SCREENS: Record<string, number> = {
  bmi: 2,
  fat: 1,
  heart: 3,
  muscle: 16,
  water: 14,
  bone: 15,
  visceral: 22,
  weather: 10,
  air: 21,
};
/** Pages that make the scale run its impedance or heart-rate measurement. */
const SENSOR_PAGES = new Set([1, 3, 14, 15, 16, 22]);

/** The `cs` screen list for a Body Smart user. `YOW_WBS13_SCREENS` names the
 * pages in order (unknown names are ignored); unset keeps BMI, fat and heart
 * rate, plus weather when a place is configured. Weather and air quality need
 * a place. Users outside the body-composition limits get no sensor pages. The
 * list is never empty: an empty list makes the scale skip its measurements. */
export function wbs13Screens(env: WeatherEnv, composition: boolean): string {
  const place = weatherPlace(env) !== null;
  const names = env.YOW_WBS13_SCREENS?.trim()
    ? env.YOW_WBS13_SCREENS.toLowerCase().split(/[\s,]+/)
    : ["bmi", "fat", "heart", "weather"];
  const ids = [
    ...new Set(
      names
        .map((name) => WBS13_SCREENS[name])
        .filter(
          (id) =>
            id !== undefined &&
            (place || (id !== 10 && id !== 21)) &&
            (composition || !SENSOR_PAGES.has(id)),
        ),
    ),
  ];
  if (!ids.some((id) => id !== 10 && id !== 21)) ids.unshift(2);
  return ids.join(",");
}

/** Whether the configured pages include air quality. */
export const wantsAir = (env: WeatherEnv) =>
  wbs13Screens(env, true).split(",").includes("21");
