import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSqlite } from "../sqlite.ts";
import { handleApp, type AppEnv } from "../app.ts";
import {
  GOAL_METRICS,
  courseCheck,
  dailyValues,
  dateTime,
  parsePlans,
  planFromForm,
  rollingAverage,
  status,
  targetAt,
  validatePlan,
  type Plan,
} from "../goals.ts";

const DAY = 86400;
const at = (date: string) => dateTime(date)!;
const plan: Plan = {
  milestones: [
    { date: "2026-01-01", targets: { weight_kg: 100, muscle_mass_kg: 70 } },
    { date: "2026-01-11", targets: { weight_kg: 95 } },
    { date: "2026-01-21", targets: { weight_kg: 93, muscle_mass_kg: 68 } },
  ],
};
const metric = (key: string) => GOAL_METRICS.find((m) => m.key === key)!;
const points = (values: Array<[number, number]>) =>
  values.map(([time, value], i) => ({ readingId: i, time, value }));

test("target follows the straight line between milestones and holds at the ends", () => {
  assert.equal(targetAt(plan, "weight_kg", at("2025-12-01")), 100);
  assert.equal(targetAt(plan, "weight_kg", at("2026-01-06")), 97.5);
  assert.equal(targetAt(plan, "weight_kg", at("2026-01-16")), 94);
  assert.equal(targetAt(plan, "weight_kg", at("2027-01-01")), 93);
  // A measure skips the milestones that leave it empty.
  assert.equal(targetAt(plan, "muscle_mass_kg", at("2026-01-11")), 69);
  assert.equal(targetAt(plan, "fat_mass_kg", at("2026-01-11")), null);
});

test("only the first reading of each local day counts, and averages use those", () => {
  const t = at("2026-01-10"); // 12:00 UTC
  const daily = dailyValues(
    points([
      [t + 3600, 101], // later the same day: ignored
      [t, 100],
      [t - DAY, 102],
      [t - 9 * DAY, 120], // outside a 7-day window
    ]),
    "UTC",
  );
  assert.deepEqual(daily.map((p) => p.value), [120, 102, 100]);
  assert.deepEqual(rollingAverage(daily, t + 7200, 7), { value: 101, days: 2 });
  assert.equal(rollingAverage(daily, t - 20 * DAY, 7), null);
});

test("status reads the plan's direction for each measure", () => {
  assert.equal(status(metric("weight_kg"), 99.9, 100).label, "On Track");
  assert.equal(status(metric("weight_kg"), 100.4, 100).label, "Close");
  assert.equal(status(metric("weight_kg"), 101, 100).label, "Behind");
  // Muscle is a floor: more is on track.
  assert.equal(status(metric("muscle_mass_kg"), 71, 70).label, "On Track");
  assert.equal(status(metric("muscle_mass_kg"), 68, 70).label, "Behind");
});

test("plans are validated: order, ranges and two points per measure", () => {
  assert.throws(() => validatePlan({ milestones: [plan.milestones[0]] }), /between 2/);
  assert.throws(
    () => validatePlan({ milestones: [plan.milestones[1], plan.milestones[0]] }),
    /in order/,
  );
  assert.throws(
    () =>
      validatePlan({
        milestones: [
          { date: "2026-01-01", targets: { weight_kg: 100 } },
          { date: "2026-02-30", targets: { weight_kg: 90 } },
        ],
      }),
    /date/,
  );
  assert.throws(
    () =>
      validatePlan({
        milestones: [
          { date: "2026-01-01", targets: { weight_kg: 100, heart_rate_bpm: 70 } },
          { date: "2026-02-01", targets: { weight_kg: 90 } },
        ],
      }),
    /at least two/,
  );
  assert.throws(
    () =>
      validatePlan({
        milestones: [
          { date: "2026-01-01", targets: { weight_kg: 100 } },
          { date: "2026-02-01", targets: { weight_kg: 900 } },
        ],
      }),
    /between/,
  );
  assert.deepEqual(validatePlan(plan), plan);
  // Damaged stored entries are dropped, not fatal.
  assert.deepEqual(parsePlans(JSON.stringify({ 1: plan, 2: { milestones: 5 } })), { 1: plan });
  assert.deepEqual(parsePlans("not json"), {});
});

test("the form reads dated rows, sorts them, and an empty form removes the plan", () => {
  const form: Record<string, string> = {
    date_0: "2026-01-21",
    weight_kg_0: "93",
    date_1: "2026-01-01",
    weight_kg_1: "100,5",
  };
  const parsed = planFromForm((name) => form[name] ?? "");
  assert.deepEqual(parsed!.milestones.map((m) => [m.date, m.targets.weight_kg]), [
    ["2026-01-01", 100.5],
    ["2026-01-21", 93],
  ]);
  assert.equal(planFromForm(() => ""), null);
  assert.throws(() => planFromForm((n) => (n === "weight_kg_2" ? "90" : "")), /needs a date/);
});

test("course check applies the fat-loss rules to morning averages", () => {
  const start = at("2026-01-01");
  const weigh = (perWeek: number) => ({
    weight_kg: points(
      Array.from({ length: 35 }, (_, d) => [start + d * DAY, 100 - (perWeek / 7) * d] as [number, number]),
    ),
  });
  const now = start + 34 * DAY;
  const long: Plan = {
    milestones: [
      { date: "2026-01-01", targets: { weight_kg: 100 } },
      { date: "2026-12-01", targets: { weight_kg: 80 } },
    ],
  };
  assert.match(courseCheck(long, weigh(0.1), now)[0].text, /150 kcal less/);
  assert.match(courseCheck(long, weigh(1.5), now)[0].text, /Eat a little more/);
  assert.match(courseCheck(long, weigh(0.6), now)[0].text, /Losing 0\.60 kg a week/);
  assert.match(courseCheck(long, weigh(0.6), start + 5 * DAY)[0].text, /First two weeks/);
  assert.match(courseCheck(long, {}, now)[0].text, /Not enough/);
  // A muscle drop over 1 kg on the 4-week average is flagged.
  const muscle = points(
    Array.from({ length: 56 }, (_, d) => [start + d * DAY, d < 28 ? 70 : 68.5] as [number, number]),
  );
  assert.ok(courseCheck(long, { ...weigh(0.6), muscle_mass_kg: muscle }, start + 55 * DAY).some((a) => /Muscle mass is down 1\.5/.test(a.text)));
  // A gain plan gets no fat-loss advice.
  const gain: Plan = { milestones: [long.milestones[1], { date: "2027-01-01", targets: { weight_kg: 85 } }] };
  assert.deepEqual(courseCheck(gain, weigh(0.1), now), []);
});

test("the Goals page saves a plan and judges smoothed readings against it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yow-goals-"));
  const store = new LocalSqlite(join(dir, "db.sqlite")),
    db = store.asD1();
  const env: AppEnv = { DB: db, ALLOW_HTTP_SCALE: true };
  let cookie = "",
    csrf = "";
  const web = async (path: string, form?: Record<string, string>) => {
    const body = form ? new URLSearchParams({ ...form, _csrf: csrf }) : undefined;
    const r = await handleApp(
      new Request(`http://localhost${path}`, {
        method: form ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          Origin: "http://localhost",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: body?.toString(),
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
      .prepare("INSERT INTO scales(id,label,model,mac,secret) VALUES(1,'Bathroom','WBS13','02:00:00:00:00:13','0123456789abcdef')")
      .run();
    await db
      .prepare(
        "INSERT INTO users(id,name,short_name,height_cm,age_years,sex,reference_weight_kg,created_at) VALUES(17,'Alex <A>','ALX',180,40,0,100,1700000000)",
      )
      .run();

    let html = await (await web("/goals?user=17")).text();
    csrf = /name="csrf-token" content="([a-f0-9]+)"/.exec(html)![1];
    assert.match(html, /No Plan Yet/);
    assert.match(html, /<a href="\/goals" aria-current="page">Goals<\/a>/);
    assert.match(html, /Alex &lt;A&gt;/);

    const today = Math.floor(Date.now() / 1000);
    const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    // Three mornings around 99 kg, plus an afternoon re-weigh that must not count.
    for (const [i, [time, grams]] of (
      [
        [today - 2 * DAY, 99_000],
        [today - DAY, 99_500],
        [today - DAY + 60, 110_000],
        [today, 98_500],
      ] as const
    ).entries())
      await db
        .prepare(
          "INSERT INTO readings(scale_id,user_id,attribution,candidate_ids,attribstatus,meastime,time_quality,weight_value,weight_unit,measures_json,payload_hash,first_received_at,last_received_at) VALUES(1,17,'device','[]',0,?,'trusted',?,-3,?,?,?,?)",
        )
        .bind(time, grams, JSON.stringify([{ value: grams, type: 1, unit: -3 }]), `h${i}`, time, time)
        .run();

    const bad = await web("/goals", { user: "17", date_0: iso(today - 10 * DAY), weight_kg_0: "100" });
    assert.equal(bad.status, 303);
    assert.match(await (await web(bad.headers.get("Location")!)).text(), /between 2/);

    const saved = await web("/goals", {
      user: "17",
      date_0: iso(today - 10 * DAY),
      weight_kg_0: "100",
      date_1: iso(today + 90 * DAY),
      weight_kg_1: "90",
    });
    assert.equal(saved.status, 303);
    html = await (await web(saved.headers.get("Location")!)).text();
    assert.match(html, /Plan saved/);
    // The 7-day average of first-of-day readings is 99.0; the target today is ~99.0.
    assert.match(html, /<p class="goal-value">99\.0 kg<\/p>/);
    assert.match(html, /7-day average · 3 days/);
    assert.match(html, /Goal <strong>90\.0 kg<\/strong>/);
    assert.match(html, /class="target"/);
    assert.match(html, /class="trend"/);
    assert.match(html, /First two weeks/);
    // The whole-plan chart reaches back to readings older than the plan.
    const later = await web("/goals", {
      user: "17",
      date_0: iso(today + DAY),
      weight_kg_0: "100",
      date_1: iso(today + 90 * DAY),
      weight_kg_1: "90",
    });
    assert.equal(later.status, 303);
    const whole = await (await web("/goals?user=17&range=plan")).text();
    assert.doesNotMatch(whole, /No readings in this period/);
    assert.match(whole, /chart, 3 readings/);
    const stored = JSON.parse(
      (await db.prepare("SELECT value FROM settings WHERE key='goal_plans'").first<{ value: string }>())!.value,
    );
    assert.deepEqual(Object.keys(stored), ["17"]);

    // Unknown users are refused; an empty form removes the plan.
    const unknown = await web("/goals", { user: "99", date_0: "2026-01-01" });
    assert.match(await (await web(unknown.headers.get("Location")!)).text(), /Unknown user/);
    const removed = await web("/goals", { user: "17" });
    html = await (await web(removed.headers.get("Location")!)).text();
    assert.match(html, /Plan removed/);
    assert.match(html, /No Plan Yet/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
