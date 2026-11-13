/** Garmin watch import: reads the watch's own FIT files (monitoring, metrics,
 * activities) and stores daily values. Node-only (the Worker never imports it).
 * Every write is an idempotent upsert, so re-importing a file the watch has
 * rewritten (today's monitoring file grows all day) never double-counts.
 */
import { createHash } from "node:crypto";
import { Decoder, Stream } from "@garmin/fitsdk";

type Msg = Record<string, any>;
/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
const FIT_EPOCH = 631065600;
const STEP_TYPES = new Set(["walking", "running"]);

export type ParsedWatchFile = {
  serial: string | null;
  product: string;
  kind: string;
  samples: Array<{ time: number; day: string; heartRate: number | null; stress: number | null }>;
  steps: Array<{ day: string; activityType: string; steps: number }>;
  daily: Array<{ day: string; metric: string; value: number; at: number }>;
  activities: Array<{
    startTime: number;
    sport: string;
    subSport: string | null;
    name: string | null;
    durationS: number | null;
    distanceM: number | null;
    calories: number | null;
    avgHr: number | null;
    maxHr: number | null;
  }>;
};

/** YYYY-MM-DD of a Unix time shifted by the watch's local offset. */
const dayOf = (unix: number, offset: number) =>
  new Date((unix + offset) * 1000).toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseWatchFile(bytes: Uint8Array): ParsedWatchFile {
  const decoder = new Decoder(Stream.fromBuffer(Buffer.from(bytes)));
  if (!decoder.isFIT()) throw new Error("Not a FIT file");
  const { messages, errors } = decoder.read({
    convertDateTimesToDates: false,
    includeUnknownData: false,
    mergeHeartRates: false,
  });
  if (errors.length) throw new Error(`FIT decode failed: ${errors[0]?.message ?? errors[0]}`);
  const fileId: Msg = messages.fileIdMesgs?.[0] ?? {};
  const out: ParsedWatchFile = {
    serial: fileId.serialNumber == null ? null : String(fileId.serialNumber),
    product: String(fileId.garminProduct ?? fileId.product ?? "Garmin"),
    kind: String(fileId.type ?? "unknown"),
    samples: [],
    steps: [],
    daily: [],
    activities: [],
  };
  const unix = (fit: number) => fit + FIT_EPOCH;

  // Monitoring: the info message carries the watch's local offset; most
  // samples carry only the low 16 bits of their time, relative to the last
  // full timestamp.
  const info: Msg | undefined = messages.monitoringInfoMesgs?.[0];
  const offset =
    info && num(info.localTimestamp) !== null && num(info.timestamp) !== null
      ? info.localTimestamp - info.timestamp
      : 0;
  let last: number | null = info?.timestamp ?? null;
  const samples = new Map<number, { heartRate: number | null; stress: number | null }>();
  const stepMax = new Map<string, number>();
  for (const m of (messages.monitoringMesgs ?? []) as Msg[]) {
    let t: number | null = null;
    if (num(m.timestamp) !== null) t = last = m.timestamp;
    else if (num(m.timestamp16) !== null && last !== null)
      t = last = last + ((m.timestamp16 - (last & 0xffff)) & 0xffff);
    if (t === null) continue;
    const time = unix(t);
    const hr = num(m.heartRate);
    if (hr !== null && hr > 0 && hr < 255)
      samples.set(time, { heartRate: hr, stress: samples.get(time)?.stress ?? null });
    const type = typeof m.activityType === "string" ? m.activityType : null;
    if (type && STEP_TYPES.has(type)) {
      const steps = num(m.steps) ?? (num(m.cycles) !== null ? Math.round(m.cycles * 2) : null);
      if (steps !== null) {
        // Counters are stamped at the end of their interval: the closing total
        // written at local midnight belongs to the day that just ended.
        const key = `${dayOf(time - 1, offset)}|${type}`;
        stepMax.set(key, Math.max(stepMax.get(key) ?? 0, steps));
      }
    }
  }
  for (const m of (messages.stressLevelMesgs ?? []) as Msg[]) {
    const v = num(m.stressLevelValue);
    if (v === null || v < 0 || v > 100 || num(m.stressLevelTime) === null) continue;
    const time = unix(m.stressLevelTime);
    samples.set(time, { heartRate: samples.get(time)?.heartRate ?? null, stress: v });
  }
  out.samples = [...samples].map(([time, s]) => ({ time, day: dayOf(time, offset), ...s }));
  out.steps = [...stepMax].map(([key, steps]) => {
    const [day, activityType] = key.split("|");
    return { day, activityType, steps };
  });
  for (const m of (messages.monitoringHrDataMesgs ?? []) as Msg[]) {
    const rhr = num(m.currentDayRestingHeartRate);
    if (rhr !== null && rhr > 0 && num(m.timestamp) !== null) {
      const at = unix(m.timestamp);
      out.daily.push({ day: dayOf(at - 1, offset), metric: "resting_hr", value: rhr, at });
    }
  }
  for (const m of (messages.maxMetDataMesgs ?? []) as Msg[]) {
    const vo2 = num(m.vo2Max);
    if (vo2 !== null && vo2 > 0 && num(m.updateTime) !== null) {
      const at = unix(m.updateTime);
      // Metrics files carry no offset; their update time is local-agnostic UTC.
      out.daily.push({ day: dayOf(at, 0), metric: "vo2max", value: vo2, at });
    }
  }
  for (const s of (messages.sessionMesgs ?? []) as Msg[]) {
    if (num(s.startTime) === null) continue;
    out.activities.push({
      startTime: unix(s.startTime),
      sport: String(s.sport ?? "generic"),
      subSport: s.subSport == null ? null : String(s.subSport),
      name: s.sportProfileName == null ? null : String(s.sportProfileName),
      durationS: num(s.totalTimerTime),
      distanceM: num(s.totalDistance),
      calories: num(s.totalCalories),
      avgHr: num(s.avgHeartRate),
      maxHr: num(s.maxHeartRate),
    });
  }
  return out;
}

export type ImportResult = "imported" | "duplicate" | "failed";

/** Imports one file; the same bytes are only ever processed once. */
export async function importWatchFile(
  db: D1Database,
  name: string,
  bytes: Uint8Array,
  now: number,
): Promise<ImportResult> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (await db.prepare("SELECT 1 AS seen FROM watch_files WHERE sha256=?").bind(sha).first())
    return "duplicate";
  let parsed: ParsedWatchFile;
  try {
    parsed = parseWatchFile(bytes);
  } catch (error) {
    await db
      .prepare("INSERT INTO watch_files(sha256,name,serial,kind,imported_at,error) VALUES(?,?,?,?,?,?)")
      .bind(sha, name, null, "unknown", now, String((error as Error).message ?? error).slice(0, 300))
      .run();
    return "failed";
  }
  const serial = parsed.serial ?? "unknown";
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO watch_devices(serial,product,first_seen_at,last_import_at) VALUES(?,?,?,?) ON CONFLICT(serial) DO UPDATE SET product=excluded.product,last_import_at=excluded.last_import_at",
      )
      .bind(serial, parsed.product, now, now),
  ];
  for (const s of parsed.samples)
    statements.push(
      db
        .prepare(
          "INSERT INTO watch_samples(serial,time,day,heart_rate,stress) VALUES(?,?,?,?,?) ON CONFLICT(serial,time) DO UPDATE SET heart_rate=COALESCE(excluded.heart_rate,heart_rate),stress=COALESCE(excluded.stress,stress)",
        )
        .bind(serial, s.time, s.day, s.heartRate, s.stress),
    );
  for (const s of parsed.steps)
    statements.push(
      db
        .prepare(
          "INSERT INTO watch_steps(serial,day,activity_type,steps) VALUES(?,?,?,?) ON CONFLICT(serial,day,activity_type) DO UPDATE SET steps=MAX(steps,excluded.steps)",
        )
        .bind(serial, s.day, s.activityType, s.steps),
    );
  for (const d of parsed.daily)
    statements.push(
      db
        .prepare(
          "INSERT INTO watch_daily(serial,day,metric,value,at) VALUES(?,?,?,?,?) ON CONFLICT(serial,day,metric) DO UPDATE SET value=excluded.value,at=excluded.at WHERE excluded.at>=watch_daily.at",
        )
        .bind(serial, d.day, d.metric, d.value, d.at),
    );
  for (const a of parsed.activities)
    statements.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO watch_activities(serial,start_time,sport,sub_sport,name,duration_s,distance_m,calories,avg_hr,max_hr) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(serial, a.startTime, a.sport, a.subSport, a.name, a.durationS, a.distanceM, a.calories, a.avgHr, a.maxHr),
    );
  statements.push(
    db
      .prepare("INSERT INTO watch_files(sha256,name,serial,kind,imported_at,error) VALUES(?,?,?,?,?,NULL)")
      .bind(sha, name, serial, parsed.kind, now),
  );
  await db.batch(statements);
  return "imported";
}
