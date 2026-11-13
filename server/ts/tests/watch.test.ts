import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Profile } from "@garmin/fitsdk";
import { LocalSqlite } from "../sqlite.ts";
import { handleApp, type AppEnv } from "../app.ts";
import { importWatchFile, parseWatchFile } from "../watch.ts";
import { scanWatchInbox } from "../watch_inbox.ts";

const N = Profile.MesgNum;
const FIT_EPOCH = 631065600;
const fit = (unix: number) => unix - FIT_EPOCH;
const SERIAL = 1234567890;

/** A synthetic monitoring file shaped like the vívoactive 4's: a full
 * timestamp, then 16-bit offsets; cumulative steps per activity type; the
 * day's closing totals stamped at the next local midnight. */
function monitoringFile(dayStart: number, offset = 0, extraSteps = 0) {
  // The SDK types messages loosely; the encoder validates them at run time.
  const e: any = new Encoder();
  e.onMesg(N.FILE_ID, { type: "monitoringB", manufacturer: "garmin", product: 3225, serialNumber: SERIAL, timeCreated: new Date(dayStart * 1000) });
  e.onMesg(N.MONITORING_INFO, { timestamp: new Date(dayStart * 1000), localTimestamp: fit(dayStart) + offset });
  const t0 = dayStart + 8 * 3600;
  e.onMesg(N.MONITORING, { timestamp: new Date(t0 * 1000), activityType: "walking", cycles: 100, heartRate: 70 });
  e.onMesg(N.MONITORING, { timestamp16: (fit(t0) + 60) & 0xffff, activityType: "walking", cycles: 500 + extraSteps / 2, heartRate: 62 });
  e.onMesg(N.MONITORING, { timestamp16: (fit(t0) + 120) & 0xffff, activityType: "running", cycles: 300 });
  e.onMesg(N.STRESS_LEVEL, { stressLevelTime: new Date((t0 + 60) * 1000), stressLevelValue: 30 });
  e.onMesg(N.STRESS_LEVEL, { stressLevelTime: new Date((t0 + 180) * 1000), stressLevelValue: -1 });
  e.onMesg(N.MONITORING_HR_DATA, { timestamp: new Date((dayStart + 86400) * 1000), restingHeartRate: 55, currentDayRestingHeartRate: 53 });
  // Closing total at the next midnight: belongs to this day.
  e.onMesg(N.MONITORING, { timestamp: new Date((dayStart + 86400) * 1000), activityType: "walking", cycles: 600 + extraSteps / 2 });
  return e.close();
}

function activityFile(start: number) {
  // The SDK types messages loosely; the encoder validates them at run time.
  const e: any = new Encoder();
  e.onMesg(N.FILE_ID, { type: "activity", manufacturer: "garmin", product: 3225, serialNumber: SERIAL, timeCreated: new Date(start * 1000) });
  e.onMesg(N.SESSION, { timestamp: new Date((start + 1800) * 1000), startTime: new Date(start * 1000), sport: "training", subSport: "strengthTraining", totalTimerTime: 1800, totalCalories: 210, avgHeartRate: 110, maxHeartRate: 150 });
  return e.close();
}

const DAY0 = Date.UTC(2026, 10, 12) / 1000;

test("monitoring files give per-day steps, heart rate, stress and resting heart rate", () => {
  const parsed = parseWatchFile(monitoringFile(DAY0));
  assert.equal(parsed.serial, String(SERIAL));
  // Walking: max cycles 600 → 1200 steps; running 300 → 600. All on 12 Nov,
  // including the closing total stamped at 13 Nov 00:00.
  assert.deepEqual(
    parsed.steps.sort((a, b) => a.activityType.localeCompare(b.activityType)),
    [
      { day: "2026-11-12", activityType: "running", steps: 600 },
      { day: "2026-11-12", activityType: "walking", steps: 1200 },
    ],
  );
  // The 16-bit offset was expanded to a full time.
  const t0 = DAY0 + 8 * 3600;
  assert.deepEqual(
    parsed.samples.sort((a, b) => a.time - b.time),
    [
      { time: t0, day: "2026-11-12", heartRate: 70, stress: null },
      { time: t0 + 60, day: "2026-11-12", heartRate: 62, stress: 30 },
    ],
  );
  assert.deepEqual(parsed.daily, [{ day: "2026-11-12", metric: "resting_hr", value: 53, at: DAY0 + 86400 }]);
  // The watch's local offset moves the day boundary.
  const local = parseWatchFile(monitoringFile(DAY0 - 3600, 3600));
  assert.ok(local.steps.every((s) => s.day === "2026-11-12"));
});

test("imports are idempotent and a rewritten file only raises the totals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yow-watch-"));
  const store = new LocalSqlite(join(dir, "db.sqlite")),
    db = store.asD1();
  try {
    const first = monitoringFile(DAY0);
    assert.equal(await importWatchFile(db, "Monitor/M1.FIT", first, 100), "imported");
    assert.equal(await importWatchFile(db, "Monitor/M1.FIT", first, 101), "duplicate");
    // The same day's file later in the day: more steps, same samples.
    assert.equal(await importWatchFile(db, "Monitor/M1.FIT", monitoringFile(DAY0, 0, 400), 102), "imported");
    assert.equal(await importWatchFile(db, "Activity/A.fit", activityFile(DAY0 + 18 * 3600), 103), "imported");
    assert.equal(await importWatchFile(db, "Monitor/bad.FIT", new Uint8Array([1, 2, 3]), 104), "failed");
    const one = async (sql: string) => (await db.prepare(sql).first()) as Record<string, any>;
    assert.equal((await one("SELECT SUM(steps) AS s FROM watch_steps")).s, 1600 + 600);
    assert.equal((await one("SELECT COUNT(*) AS n FROM watch_samples")).n, 2);
    assert.equal((await one("SELECT value FROM watch_daily WHERE metric='resting_hr'")).value, 53);
    assert.deepEqual(
      { ...(await one("SELECT sport,sub_sport,duration_s,calories FROM watch_activities")) },
      { sport: "training", sub_sport: "strengthTraining", duration_s: 1800, calories: 210 },
    );
    assert.match((await one("SELECT error FROM watch_files WHERE name='Monitor/bad.FIT'")).error, /FIT/);
    assert.equal((await one("SELECT last_import_at FROM watch_devices")).last_import_at, 103);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inbox scan imports nested files, skips staging, and skips unchanged files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yow-inbox-"));
  const store = new LocalSqlite(join(dir, "db.sqlite")),
    db = store.asD1();
  try {
    const inbox = join(dir, "inbox");
    mkdirSync(join(inbox, "Monitor"), { recursive: true });
    mkdirSync(join(inbox, ".staging"), { recursive: true });
    writeFileSync(join(inbox, "Monitor", "M1.FIT"), monitoringFile(DAY0));
    writeFileSync(join(inbox, ".staging", "M2.FIT"), new Uint8Array([9, 9]));
    writeFileSync(join(inbox, "sync.log"), "not fit");
    const seen = new Map<string, string>();
    assert.deepEqual(await scanWatchInbox(db, inbox, seen), { imported: 1, duplicate: 0, failed: 0 });
    assert.deepEqual(await scanWatchInbox(db, inbox, seen), { imported: 0, duplicate: 0, failed: 0 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a linked watch feeds resting heart rate and steps into Goals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yow-watch-goals-"));
  const store = new LocalSqlite(join(dir, "db.sqlite")),
    db = store.asD1();
  const env: AppEnv = { DB: db, ALLOW_HTTP_SCALE: true };
  let cookie = "",
    csrf = "";
  const web = async (path: string, form?: Record<string, string>) => {
    const r = await handleApp(
      new Request(`http://localhost${path}`, {
        method: form ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          Origin: "http://localhost",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams({ ...form, _csrf: csrf }).toString() : undefined,
      }),
      env,
    );
    if (r.headers.has("Set-Cookie")) cookie = r.headers.get("Set-Cookie")!.split(";")[0];
    return r;
  };
  try {
    csrf = /name="_csrf" value="([a-f0-9]+)"/.exec(await (await web("/setup")).text())![1];
    await web("/setup", { password: "test-password", confirm: "test-password" });
    await db
      .prepare("INSERT INTO users(id,name,short_name,height_cm,age_years,sex,reference_weight_kg,created_at) VALUES(17,'Alex','ALX',180,40,0,100,1700000000)")
      .run();
    const today = Math.floor(Date.now() / 1000);
    const yesterday = Math.floor(today / 86400) * 86400 - 86400;
    await importWatchFile(db, "Monitor/M1.FIT", monitoringFile(yesterday), today);

    let html = await (await web("/goals?user=17")).text();
    csrf = /name="csrf-token" content="([a-f0-9]+)"/.exec(html)![1];
    assert.match(html, /not linked yet/);
    const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    await web("/goals", {
      user: "17",
      date_0: iso(today - 5 * 86400),
      resting_hr_bpm_0: "55",
      steps_0: "5000",
      date_1: iso(today + 90 * 86400),
      resting_hr_bpm_1: "50",
      steps_1: "10000",
    });
    const linked = await web("/goals/watch", { user: "17", serial: String(SERIAL), link: "1" });
    assert.equal(linked.status, 303);
    html = await (await web(linked.headers.get("Location")!)).text();
    assert.match(html, /Watch linked/);
    assert.match(html, /Unlink/);
    assert.match(html, /Resting Heart Rate[\s\S]*?<p class="goal-value">53 bpm<\/p>/);
    assert.match(html, /Steps[\s\S]*?<p class="goal-value">1800<\/p>/);

    // Another user's link is refused for unknown watches.
    const bad = await web("/goals/watch", { user: "17", serial: "nope", link: "1" });
    assert.match(await (await web(bad.headers.get("Location")!)).text(), /Unknown user or watch/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
