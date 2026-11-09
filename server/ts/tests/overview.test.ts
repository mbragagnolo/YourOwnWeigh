import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSqlite } from "../sqlite.ts";
import { handleApp, type AppEnv } from "../app.ts";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
// The observed WBS13 composition group (synthetic person, real wire shape).
const composition = (weight: number) => [
  { value: weight, type: 1, unit: -3 },
  { value: 3000, type: 8, unit: -2 },
  { value: 7000, type: 5, unit: -2 },
  { value: 4680, type: 77, unit: -2 },
  { value: 360, type: 88, unit: -2 },
  { value: 6640, type: 76, unit: -2 },
  { value: 64, type: 170, unit: -1 },
  { value: 1950, type: 226, unit: 0 },
  { value: 44, type: 227, unit: 0 },
  { value: 600, type: 189, unit: 0 },
];

async function harness(users = true) {
  const dir = mkdtempSync(join(tmpdir(), "yow-overview-"));
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
    if (r.headers.has("Set-Cookie"))
      cookie = r.headers.get("Set-Cookie")!.split(";")[0];
    return r;
  };
  csrf = /name="_csrf" value="([a-f0-9]+)"/.exec(await (await web("/setup")).text())![1];
  assert.equal((await web("/setup", { password: "test-password", confirm: "test-password" })).status, 303);
  await db
    .prepare("INSERT INTO scales(id,label,model,mac,secret) VALUES(1,'Bathroom','WBS13','02:00:00:00:00:13','0123456789abcdef')")
    .run();
  if (users)
    await db
      .prepare(
        "INSERT INTO users(id,name,short_name,height_cm,age_years,sex,reference_weight_kg,created_at) VALUES(17,'Alex <A>','ALX',180,40,0,100,1700000000),(18,'Sam','SAM',170,35,1,70,1700000000)",
      )
      .run();
  let hash = 0;
  const reading = async (
    user: number | null,
    meastime: number,
    measures: Array<{ type: number; value: number; unit: number }>,
    extra: { measures_json?: string } = {},
  ) => {
    const weight = measures.find((m) => m.type === 1);
    await db
      .prepare(
        "INSERT INTO readings(scale_id,user_id,attribution,candidate_ids,attribstatus,meastime,time_quality,weight_value,weight_unit,measures_json,payload_hash,first_received_at,last_received_at) VALUES(1,?,'device','[]',0,?,'trusted',?,?,?,?,?,?)",
      )
      .bind(
        user,
        meastime,
        weight?.value ?? null,
        weight?.unit ?? null,
        extra.measures_json ?? JSON.stringify(measures),
        `hash-${hash++}`,
        meastime + 20,
        meastime + 20,
      )
      .run();
  };
  const page = async (query = "") => {
    const r = await web(`/${query}`);
    assert.equal(r.status, 200);
    return r.text();
  };
  return {
    db,
    page,
    reading,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const tile = (html: string, label: string) => {
  const m = new RegExp(`<article class="tile"[^>]*data-metric="${label}"[\\s\\S]*?</article>`).exec(html);
  assert.ok(m, `tile ${label}`);
  return m[0];
};
const charts = (html: string) =>
  [...html.matchAll(/<figure class="chart"><figcaption>([^<]+)<\/figcaption>/g)].map((m) => m[1]);
const dots = (html: string, caption: string) => {
  const fig = new RegExp(`<figure class="chart"><figcaption>${caption}</figcaption>[\\s\\S]*?</figure>`).exec(html);
  assert.ok(fig, `chart ${caption}`);
  return (fig[0].match(/<circle\b/g) ?? []).length;
};

test("tabs choose one user at a time and fall back to the first user", async () => {
  const h = await harness();
  try {
    let html = await h.page();
    assert.match(html, /<a[^>]*href="\/\?user=17[^"]*"[^>]*aria-current="page"[^>]*>Alex &lt;A&gt;<\/a>/);
    assert.match(html, /<a[^>]*href="\/\?user=18[^"]*"[^>]*>Sam<\/a>/);
    html = await h.page("?user=18");
    assert.match(html, /href="\/\?user=18[^"]*"[^>]*aria-current="page"/);
    html = await h.page("?user=999");
    assert.match(html, /href="\/\?user=17[^"]*"[^>]*aria-current="page"/);
    assert.doesNotMatch(html, /Alex <A>/); // Escaped everywhere.
  } finally {
    h.cleanup();
  }
});

test("tiles show the latest value, the rating and the change since the previous reading", async () => {
  const h = await harness();
  try {
    const t = now() - 2 * DAY;
    await h.reading(17, t - DAY, composition(101000));
    await h.reading(17, t, composition(100000));
    await h.reading(17, t, [{ type: 11, value: 70, unit: 0 }]);
    const html = await h.page();
    const weight = tile(html, "weight_kg");
    assert.match(weight, /100\.0 kg/);
    assert.match(weight, /▼ 1\.0 kg/);
    assert.doesNotMatch(weight, /class="badge/); // Weight itself is not rated.
    const fat = tile(html, "fat_ratio_pct");
    assert.match(fat, /30\.0 %/);
    assert.match(fat, /<span class="badge bad">Very High<\/span>/);
    assert.match(tile(html, "bmi"), /30\.9[\s\S]*<span class="badge bad">Obese<\/span>/);
    assert.match(tile(html, "water_pct"), /<span class="badge warn">Low<\/span>/);
    assert.match(tile(html, "visceral_fat_index"), /6\.4[\s\S]*<span class="badge warn">High<\/span>/);
    assert.match(tile(html, "metabolic_age_years"), /44 years[\s\S]*Above Your Age/);
    assert.match(tile(html, "heart_rate_bpm"), /70 bpm[\s\S]*<span class="badge">Normal<\/span>/);
    assert.doesNotMatch(tile(html, "heart_rate_bpm"), /[▲▼]/); // Only one heart-rate reading.
    assert.doesNotMatch(tile(html, "muscle_mass_kg"), /class="badge/);
    assert.doesNotMatch(html, /data-metric="189"/);
    assert.match(html, /not medical advice/i);
    assert.match(html, /Gallagher/);
    assert.match(html, /href="\/readings"/);
  } finally {
    h.cleanup();
  }
});

test("a newer weight-only reading does not hide composition or heart rate", async () => {
  const h = await harness();
  try {
    const t = now() - 3 * DAY;
    await h.reading(17, t, composition(100000));
    await h.reading(17, t, [{ type: 11, value: 70, unit: 0 }]);
    await h.reading(17, t + DAY, [{ type: 1, value: 99200, unit: -3 }]);
    const html = await h.page();
    assert.match(tile(html, "weight_kg"), /99\.2 kg/);
    assert.match(tile(html, "heart_rate_bpm"), /70 bpm/);
    assert.match(tile(html, "fat_ratio_pct"), /30\.0 %/);
  } finally {
    h.cleanup();
  }
});

test("weight is always charted; other charts are opt-in and only for measured metrics", async () => {
  const h = await harness();
  try {
    await h.reading(17, now() - DAY, composition(100000));
    let html = await h.page();
    assert.deepEqual(charts(html), ["Weight"]);
    html = await h.page("?user=17&show=fat_ratio_pct&show=heart_rate_bpm&show=bogus");
    assert.deepEqual(charts(html), ["Weight", "Body Fat"]);
    assert.match(html, /<rect class="band"/); // Body fat shows its healthy range.
    // The chart toggles are a plain GET form keeping the user and range.
    assert.match(html, /<input type="checkbox" name="show" value="fat_ratio_pct" checked/);
    assert.match(html, /<input type="hidden" name="user" value="17">/);
    assert.match(html, /<input type="hidden" name="range" value="3m">/);
    assert.doesNotMatch(html, /name="show" value="heart_rate_bpm"/); // No data, no toggle.
    assert.doesNotMatch(html, /name="show" value="weight_kg"/); // Always shown.
  } finally {
    h.cleanup();
  }
});

test("range buttons filter the charts and keep the user and chart choices", async () => {
  const h = await harness();
  try {
    for (const age of [1, 20, 60, 200, 500])
      await h.reading(17, now() - age * DAY, [{ type: 1, value: 100000 + age, unit: -3 }]);
    assert.equal(dots(await h.page(), "Weight"), 3); // Default: 3 months.
    assert.equal(dots(await h.page("?range=1m"), "Weight"), 2);
    assert.equal(dots(await h.page("?range=1y"), "Weight"), 4);
    assert.equal(dots(await h.page("?range=all"), "Weight"), 5);
    assert.equal(dots(await h.page("?range=forever"), "Weight"), 3);
    const html = await h.page("?user=17&range=1y&show=bmi");
    assert.match(html, /href="\/\?user=17&amp;range=all&amp;show=bmi"/);
    assert.match(html, /<a[^>]*href="\/\?user=17&amp;range=1y&amp;show=bmi"[^>]*aria-current="page"/);
    assert.deepEqual(charts(html), ["Weight", "BMI"]);
    // Tiles always use the latest reading, whatever the chart range.
    assert.match(tile(await h.page("?range=1m"), "weight_kg"), /100\.0 kg/);
  } finally {
    h.cleanup();
  }
});

test("mass values follow the display unit", async () => {
  const h = await harness();
  try {
    await h.db.prepare("INSERT INTO settings(key,value) VALUES('display_weight_unit','lb')").run();
    await h.reading(17, now() - 2 * DAY, composition(101000));
    await h.reading(17, now() - DAY, composition(100000));
    const html = await h.page();
    assert.match(tile(html, "weight_kg"), /220\.5 lb/);
    assert.match(tile(html, "weight_kg"), /▼ 2\.2 lb/);
    assert.match(tile(html, "muscle_mass_kg"), /146\.4 lb/);
    assert.match(tile(html, "fat_ratio_pct"), /30\.0 %/); // Percentages are unit-free.
  } finally {
    h.cleanup();
  }
});

test("empty states and malformed rows do not break the page", async () => {
  const none = await harness(false);
  try {
    assert.match(await none.page(), /No users have been added yet/);
  } finally {
    none.cleanup();
  }
  const h = await harness();
  try {
    let html = await h.page("?user=18");
    assert.match(html, /No readings recorded yet/);
    assert.doesNotMatch(html, /<svg/);
    await h.reading(17, now() - DAY, [{ type: 1, value: 80000, unit: -3 }], { measures_json: "{broken" });
    await h.reading(17, now() - 2 * DAY, [{ type: 1, value: 81000, unit: -3 }]);
    html = await h.page();
    assert.match(tile(html, "weight_kg"), /81\.0 kg/);
    // Unassigned readings belong to nobody's overview.
    await h.reading(null, now(), [{ type: 1, value: 50000, unit: -3 }]);
    assert.doesNotMatch(await h.page(), /50\.0 kg/);
  } finally {
    h.cleanup();
  }
});
