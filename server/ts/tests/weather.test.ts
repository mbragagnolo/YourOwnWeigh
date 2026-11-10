import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSqlite } from "../sqlite.ts";
import { handleApp, type AppEnv } from "../app.ts";
import {
  clearWeatherCache,
  weatherIcon,
  weatherPlace,
  weatherSeries,
} from "../weather.ts";

// Synthetic Body Smart identity (locally administered MAC) and place.
const MAC = "02:00:00:00:00:13",
  SECRET = "0123456789abcdef";
const PLACE = { YOW_WEATHER_LATITUDE: "52.5234", YOW_WEATHER_LONGITUDE: "13.4114" };

/** An Open-Meteo style hourly reply for two days at UTC+1. */
function reply(offset = 3600) {
  const time: string[] = [],
    temperature_2m: number[] = [],
    weather_code: number[] = [];
  for (const day of ["2026-11-10", "2026-11-11"])
    for (let hour = 0; hour < 24; hour++) {
      time.push(`${day}T${String(hour).padStart(2, "0")}:00`);
      temperature_2m.push(hour + (day.endsWith("11") ? 0.6 : -0.4));
      weather_code.push(hour === 6 ? 0 : hour === 12 ? 61 : 3);
    }
  return { utc_offset_seconds: offset, hourly: { time, temperature_2m, weather_code } };
}

test("weatherPlace needs two valid coordinates and rounds them to about a kilometre", () => {
  assert.deepEqual(weatherPlace(PLACE), { latitude: 52.52, longitude: 13.41 });
  assert.deepEqual(
    weatherPlace({ YOW_WEATHER_LATITUDE: "-33.9", YOW_WEATHER_LONGITUDE: " 18.4 " }),
    { latitude: -33.9, longitude: 18.4 },
  );
  for (const bad of [
    {},
    { YOW_WEATHER_LATITUDE: "52.5" },
    { YOW_WEATHER_LATITUDE: "", YOW_WEATHER_LONGITUDE: "" },
    { YOW_WEATHER_LATITUDE: "91", YOW_WEATHER_LONGITUDE: "0" },
    { YOW_WEATHER_LATITUDE: "0", YOW_WEATHER_LONGITUDE: "181" },
    { YOW_WEATHER_LATITUDE: "north", YOW_WEATHER_LONGITUDE: "0" },
  ])
    assert.equal(weatherPlace(bad), null, JSON.stringify(bad));
});

test("weatherIcon maps WMO codes onto the scale's icons", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 45, 48, 51, 61, 65, 71, 80, 86, 95, 99].map(weatherIcon),
    [1, 4, 4, 3, 3, 3, 6, 6, 6, 6, 6, 6, 5, 5],
  );
});

test("weatherSeries fills the eight slots with 06:00 and 12:00 under both clock readings", () => {
  const series = weatherSeries(reply());
  const at = (iso: string) => Date.parse(iso) / 1000;
  assert.deepEqual(series, [
    { ti: at("2026-11-10T05:00Z"), te: 6, ic: 1 },
    { ti: at("2026-11-10T06:00Z"), te: 6, ic: 1 },
    { ti: at("2026-11-10T11:00Z"), te: 12, ic: 6 },
    { ti: at("2026-11-10T12:00Z"), te: 12, ic: 6 },
    { ti: at("2026-11-11T05:00Z"), te: 7, ic: 1 },
    { ti: at("2026-11-11T06:00Z"), te: 7, ic: 1 },
    { ti: at("2026-11-11T11:00Z"), te: 13, ic: 6 },
    { ti: at("2026-11-11T12:00Z"), te: 13, ic: 6 },
  ]);
  // UTC needs one reading; a half-hour zone keeps only on-the-hour slots.
  assert.equal(weatherSeries(reply(0)).length, 4);
  const halfHour = weatherSeries(reply(19800));
  assert.equal(halfHour.length, 4);
  assert.ok(halfHour.every((entry) => entry.ti % 3600 === 0));
  for (const bad of [null, {}, { hourly: {} }, { utc_offset_seconds: 0, hourly: { time: ["x"] } }])
    assert.deepEqual(weatherSeries(bad), []);
});

// Stamp for user 17 with screens "2,1,3" (no weather).
const PLAIN_STAMP = 353749227;

async function harness(extra: Partial<AppEnv>) {
  clearWeatherCache();
  const dir = mkdtempSync(join(tmpdir(), "yow-weather-"));
  const store = new LocalSqlite(join(dir, "weather.db")),
    db = store.asD1();
  const env: AppEnv = { DB: db, ALLOW_HTTP_SCALE: true, ...extra };
  // Create the schema through first-run setup, then seed one scale and user.
  const setup = await handleApp(new Request("http://localhost/setup"), env);
  assert.equal(setup.status, 200);
  await db
    .prepare(
      "INSERT INTO scales(id,label,model,mac,secret,settings_ready,time_zone) VALUES(1,'Bathroom','WBS13',?,?,1,'Europe/Berlin')",
    )
    .bind(MAC.replaceAll(":", "").toUpperCase(), SECRET)
    .run();
  await db
    .prepare(
      "INSERT INTO users(id,name,short_name,height_cm,sex,age_years,reference_weight_kg,active,created_at) VALUES(17,'Sam','SAM',181,0,40,80,1,1793468363)",
    )
    .run();
  await db
    .prepare("INSERT INTO scale_users(scale_id,user_id,rank) VALUES(1,17,1)")
    .run();
  const post = (path: string, fields: Record<string, string>) =>
    handleApp(
      new Request(`http://scales.test${path}`, {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
      env,
    );
  const open = async () => {
    const once = ((await (await post("/once", { action: "get" })).json()) as any)
      .body.once;
    const response = await post("/session?appname=WBS13&appliver=103", {
      action: "new",
      auth: MAC,
      hashmethod: "sha256",
      hash: createHash("sha256").update(`${MAC}:${SECRET}:${once}`).digest("hex"),
      currentfw: "103",
    });
    assert.equal(response.status, 200, await response.clone().text());
    return ((await response.json()) as any).body;
  };
  const audit = async () =>
    (
      await db
        .prepare("SELECT outcome FROM sync_audit WHERE endpoint='weather' ORDER BY rowid")
        .all<{ outcome: string }>()
    ).results.map((row) => row.outcome);
  return {
    post,
    open,
    audit,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("WBS13 without a configured place keeps its screens and receives no forecast", async () => {
  let calls = 0;
  const h = await harness({
    weatherFetch: async () => {
      calls++;
      throw new Error("must not fetch");
    },
  });
  try {
    const session = await h.open();
    assert.equal(session.sp.users[0].cs, "2,1,3");
    const stamp = ((await (
      await h.post("/v2/measure", {
        sessionid: session.sessionid,
        action: "getlastupdate",
        objects: "devices",
      })
    ).json()) as any).body.devices;
    assert.deepEqual(stamp, [{ screen: PLAIN_STAMP, screencontent: 1 }]);
    const weather = await h.post("/v2/weather", {
      sessionid: session.sessionid,
      action: "getforecast",
    });
    assert.deepEqual(await weather.json(), { status: 0, body: {} });
    assert.equal(calls, 0);
    assert.deepEqual(await h.audit(), ["suppressed"]);
  } finally {
    h.cleanup();
  }
});

test("WBS13 with a configured place lists the weather screen and serves a cached live forecast", async () => {
  const urls: URL[] = [];
  let fail = false;
  const h = await harness({
    ...PLACE,
    weatherFetch: async (input) => {
      urls.push(new URL(String(input)));
      if (fail) throw new Error("offline");
      return Response.json(reply());
    },
  });
  try {
    const session = await h.open();
    assert.equal(session.sp.users[0].cs, "2,1,3,10");
    const screen = await h.post("/v2/screen", {
      sessionid: session.sessionid,
      action: "getbydeviceid",
    });
    assert.deepEqual(
      ((await screen.json()) as any).body.user[0].screens.map((s: any) => s.embid),
      [2, 1, 3, 10],
    );
    // The stamp that makes the scale refetch its screens follows the list.
    const stamp = ((await (
      await h.post("/v2/measure", {
        sessionid: session.sessionid,
        action: "getlastupdate",
        objects: "devices",
      })
    ).json()) as any).body.devices;
    assert.equal(stamp.length, 1);
    assert.equal(stamp[0].screencontent, 1);
    assert.ok(stamp[0].screen > 0 && stamp[0].screen < 0x7fffffff);
    assert.notEqual(stamp[0].screen, PLAIN_STAMP);
    const ask = async () =>
      (await (
        await h.post("/v2/weather", {
          sessionid: session.sessionid,
          action: "getforecast",
        })
      ).json()) as any;
    const first = await ask();
    assert.equal(first.status, 0);
    assert.equal(first.body.series.w.length, 8);
    assert.deepEqual(first.body.series.w[0], {
      ti: Date.parse("2026-11-10T05:00Z") / 1000,
      te: 6,
      ic: 1,
    });
    // Only rounded coordinates and the scale's time zone leave the server.
    assert.equal(urls.length, 1);
    assert.equal(urls[0].origin, "https://api.open-meteo.com");
    assert.deepEqual(Object.fromEntries(urls[0].searchParams), {
      latitude: "52.52",
      longitude: "13.41",
      hourly: "temperature_2m,weather_code",
      timezone: "Europe/Berlin",
      forecast_days: "2",
    });
    fail = true;
    assert.deepEqual(await ask(), first);
    assert.equal(urls.length, 1, "second request is served from the cache");
    assert.deepEqual(await h.audit(), ["served", "served"]);
  } finally {
    h.cleanup();
  }
});

test("WBS13 receives an empty weather reply when the forecast provider is unreachable", async () => {
  const h = await harness({
    ...PLACE,
    weatherFetch: async () => new Response("down", { status: 503 }),
  });
  try {
    const session = await h.open();
    const weather = await h.post("/v2/weather", {
      sessionid: session.sessionid,
      action: "getforecast",
    });
    assert.equal(weather.status, 200);
    assert.deepEqual(await weather.json(), { status: 0, body: {} });
    assert.deepEqual(await h.audit(), ["unavailable"]);
  } finally {
    h.cleanup();
  }
});
