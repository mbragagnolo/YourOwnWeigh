import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_AQI,
  airSeries,
  clearWeatherCache,
  forecast,
  wantsAir,
  wbs13Screens,
} from "../weather.ts";

const PLACE = { YOW_WEATHER_LATITUDE: "52.52", YOW_WEATHER_LONGITUDE: "13.41" };
const ALL = "bmi,fat,muscle,water,bone,visceral,heart,weather,air";

/** Open-Meteo style hourly replies for two days at UTC+1. */
function hours(field: string, value: (hour: number) => number | null) {
  const time: string[] = [],
    values: Array<number | null> = [];
  for (const day of ["2026-11-10", "2026-11-11"])
    for (let hour = 0; hour < 24; hour++) {
      time.push(`${day}T${String(hour).padStart(2, "0")}:00`);
      values.push(value(hour));
    }
  return { utc_offset_seconds: 3600, hourly: { time, [field]: values } };
}
const weather = () => {
  const reply = hours("temperature_2m", (hour) => hour);
  return {
    ...reply,
    hourly: { ...reply.hourly, weather_code: reply.hourly.time.map(() => 3) },
  };
};

test("wbs13Screens keeps the default pages and honours a configured order", () => {
  assert.equal(wbs13Screens({}, true), "2,1,3");
  assert.equal(wbs13Screens({}, false), "2");
  assert.equal(wbs13Screens(PLACE, true), "2,1,3,10");
  assert.equal(wbs13Screens(PLACE, false), "2,10");
  const all = { ...PLACE, YOW_WBS13_SCREENS: ALL };
  assert.equal(wbs13Screens(all, true), "2,1,16,14,15,22,3,10,21");
  // Outside the composition limits no page may start a sensor measurement.
  assert.equal(wbs13Screens(all, false), "2,10,21");
  // Weather and air quality need a place; names are forgiving; no duplicates.
  assert.equal(wbs13Screens({ YOW_WBS13_SCREENS: ALL }, true), "2,1,16,14,15,22,3");
  assert.equal(
    wbs13Screens({ ...PLACE, YOW_WBS13_SCREENS: " Water  FAT,fat, nonsense,weather " }, true),
    "14,1,10",
  );
  // Never empty, and never only forecast pages.
  assert.equal(wbs13Screens({ ...PLACE, YOW_WBS13_SCREENS: "nonsense" }, true), "2");
  assert.equal(wbs13Screens({ ...PLACE, YOW_WBS13_SCREENS: "weather,air" }, true), "2,10,21");
  assert.equal(wbs13Screens({ ...PLACE, YOW_WBS13_SCREENS: "fat" }, false), "2");
  assert.equal(wantsAir(all), true);
  assert.equal(wantsAir(PLACE), false);
  assert.equal(wantsAir({ YOW_WBS13_SCREENS: ALL }), false);
});

test("airSeries takes the European AQI at the scale's slots and skips gaps", () => {
  const series = airSeries(hours("european_aqi", (hour) => (hour === 12 ? null : 30.4 + hour)));
  assert.deepEqual(
    series.map((entry) => entry.aqi),
    [36, 36, 36, 36],
  );
  assert.ok(series.every((entry) => entry.ti % 3600 === 0));
  assert.deepEqual(airSeries({}), []);
});

test("forecast adds air quality to every weather slot, or marks it missing", async () => {
  clearWeatherCache();
  const hosts: string[] = [];
  let airDown = false;
  const env = {
    weatherFetch: (async (input: URL) => {
      hosts.push(input.host);
      if (input.host.startsWith("air-quality")) {
        if (airDown) return new Response("down", { status: 503 });
        assert.equal(input.searchParams.get("hourly"), "european_aqi");
        assert.equal(input.searchParams.get("latitude"), "52.52");
        return Response.json(hours("european_aqi", (hour) => 20 + hour));
      }
      return Response.json(weather());
    }) as unknown as typeof fetch,
  };
  const place = { latitude: 52.52, longitude: 13.41 };
  const plain = await forecast(env, place, "Europe/Berlin");
  assert.equal(plain?.w.length, 8);
  assert.equal(plain?.aq, undefined);
  assert.deepEqual(hosts, ["api.open-meteo.com"]);

  const withAir = await forecast(env, place, "Europe/Berlin", true);
  assert.deepEqual(
    withAir?.aq?.map((entry) => entry.ti),
    withAir?.w.map((entry) => entry.ti),
  );
  assert.deepEqual(
    withAir?.aq?.map((entry) => entry.aqi),
    [26, 26, 32, 32, 26, 26, 32, 32],
  );

  // Weather still arrives when only the air quality lookup fails.
  clearWeatherCache();
  airDown = true;
  const degraded = await forecast(env, place, "Europe/Berlin", true);
  assert.equal(degraded?.w.length, 8);
  assert.ok(degraded?.aq?.every((entry) => entry.aqi === NO_AQI));
});
