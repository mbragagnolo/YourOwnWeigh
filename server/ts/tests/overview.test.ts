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
const row = (html: string, key: string) => {
  const m = new RegExp(`<a class="measure"[^>]*data-metric="${key}"[\\s\\S]*?</a>`).exec(html);
  assert.ok(m, `row ${key}`);
  return m[0];
};
const hero = (html: string) => {
  const m = /<section class="weight-hero">[\s\S]*?<\/section>/.exec(html);
  assert.ok(m, "weight header");
  return m[0];
};
const charts = (html: string) =>
  [...html.matchAll(/<figure class="chart"><figcaption>([^<]+)<\/figcaption>/g)].map((m) => m[1]);
const dots = (html: string, caption: string) => {
  const fig = new RegExp(`<figure class="chart"><figcaption>${caption}</figcaption>[\\s\\S]*?</figure>`).exec(html);
  assert.ok(fig, `chart ${caption}`);
  return (fig[0].match(/<circle\b/g) ?? []).length;
};
const marker = (html: string) => Number(/class="marker" style="left:([\d.]+)%"/.exec(html)?.[1]);
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

test("the overview leads with weight, its change and its chart", async () => {
  const h = await harness();
  try {
    const t = now() - 2 * DAY;
    await h.reading(17, t - DAY, composition(101000));
    await h.reading(17, t, composition(100000));
    const html = await h.page();
    const top = hero(html);
    assert.match(top, /<p class="hero-value">100\.0 kg<\/p>/);
    assert.match(top, /▼ 1\.0 %/); // (100 − 101) / 101
    assert.match(top, /since the previous weigh-in/i);
    assert.deepEqual(charts(top), ["Weight"]);
    assert.match(top, /<nav class="range-links"/);
    assert.deepEqual(charts(html), ["Weight"]); // Other charts live on their own pages.
    assert.doesNotMatch(html, /type="checkbox"|Also Chart/);
    assert.doesNotMatch(html, /data-metric="weight_kg"/); // Weight is in the header, not a row.
  } finally {
    h.cleanup();
  }
});

test("the composition bar splits the latest weight into muscle, fat and bone", async () => {
  const h = await harness();
  try {
    await h.reading(17, now() - DAY, composition(100000));
    const html = await h.page();
    const bar = /<div class="composition"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    assert.match(bar, /class="comp muscle" style="width:66\.40%"/);
    assert.match(bar, /class="comp fat" style="width:30\.00%"/);
    assert.match(bar, /class="comp bone" style="width:3\.60%"/);
    assert.match(html, /Muscle 66\.4 %[\s\S]*Fat 30\.0 %[\s\S]*Bone 3\.6 %/);
  } finally {
    h.cleanup();
  }
});

test("each measurement row shows its rating and a range bar, and opens its page", async () => {
  const h = await harness();
  try {
    const t = now() - 2 * DAY;
    await h.reading(17, t - DAY, composition(101000));
    await h.reading(17, t, composition(100000));
    await h.reading(17, t, [{ type: 11, value: 70, unit: 0 }]);
    const html = await h.page();
    const bmi = row(html, "bmi");
    assert.match(bmi, /href="\/\?user=17&amp;range=3m&amp;metric=bmi"/);
    assert.match(bmi, /BMI[\s\S]*<span class="rating bad">Obese<\/span>[\s\S]*30\.9/);
    assert.equal((bmi.match(/class="seg /g) ?? []).length, 4);
    assert.match(bmi, /class="seg warn"[\s\S]*class="seg good"[\s\S]*class="seg warn"[\s\S]*class="seg bad"/);
    assert.ok(Math.abs(marker(bmi) - 79.3) < 1, String(marker(bmi))); // 30.9 in the open Obese band.
    assert.match(row(html, "fat_ratio_pct"), /30\.0 %[\s\S]*<span class="rating bad">Very High<\/span>|<span class="rating bad">Very High<\/span>[\s\S]*30\.0 %/);
    assert.match(row(html, "water_pct"), /<span class="rating warn">Low<\/span>/);
    const visceral = row(html, "visceral_fat_index");
    assert.match(visceral, /6\.4/);
    assert.match(visceral, /<span class="rating warn">High<\/span>/);
    assert.equal((visceral.match(/class="seg /g) ?? []).length, 3);
    assert.match(row(html, "metabolic_age_years"), /44 years[\s\S]*Above Your Age|Above Your Age[\s\S]*44 years/);
    assert.match(row(html, "heart_rate_bpm"), /70 bpm/);
    assert.match(row(html, "heart_rate_bpm"), /<span class="rating good">Normal<\/span>/);
    // Unrated measurements: value only, no rating and no bar.
    const muscle = row(html, "muscle_mass_kg");
    assert.match(muscle, /66\.4 kg/);
    assert.doesNotMatch(muscle, /class="rating|class="range-bar/);
    assert.doesNotMatch(html, /data-metric="189"/);
    assert.match(html, /not medical advice/i);
    assert.match(html, /Gallagher/);
    assert.match(html, /href="\/readings"/);
  } finally {
    h.cleanup();
  }
});

test("a measurement page shows the verdict, the reference, a labelled bar and its chart", async () => {
  const h = await harness();
  try {
    const t = now() - 2 * DAY;
    await h.reading(17, t - DAY, composition(101000));
    await h.reading(17, t, composition(100000));
    const html = await h.page("?user=17&metric=fat_ratio_pct");
    assert.match(html, /<a class="back" href="\/\?user=17&amp;range=3m">/);
    assert.match(html, /<h1>Body Fat<\/h1>/);
    assert.match(html, /<p class="verdict">Your body fat is in the very high range<\/p>/);
    assert.match(html, /Reference values for men 40–59 \(Gallagher et al\. 2000\)/);
    assert.match(html, /<p class="hero-value">30\.0 %<\/p>/);
    assert.match(html, /▲ 0\.3 %/); // Same fat mass, lower weight: 29.7 % → 30.0 %.
    const bar = /<div class="range-bar labelled"[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? "";
    for (const edge of ["11", "22", "28"]) assert.match(bar, new RegExp(`class="edge"[^>]*>${edge}<`));
    for (const name of ["Low", "Healthy", "High", "Very High"])
      assert.match(bar, new RegExp(`class="band-name">${name}<`));
    assert.deepEqual(charts(html), ["Body Fat"]);
    assert.match(html, /<rect class="band"/);
    // The range buttons and the user tabs keep the measurement.
    assert.match(html, /href="\/\?user=17&amp;range=1y&amp;metric=fat_ratio_pct"/);
    assert.match(html, /href="\/\?user=18&amp;range=3m&amp;metric=fat_ratio_pct"/);
    // Unrated measurements get a page too, without verdict or bar.
    const muscle = await h.page("?user=17&metric=muscle_mass_kg");
    assert.match(muscle, /<h1>Muscle Mass<\/h1>/);
    assert.doesNotMatch(muscle, /class="verdict"|class="range-bar/);
    assert.deepEqual(charts(muscle), ["Muscle Mass"]);
  } finally {
    h.cleanup();
  }
});

test("an unknown measurement, or one without data, falls back to the overview", async () => {
  const h = await harness();
  try {
    await h.reading(17, now() - DAY, composition(100000));
    for (const query of ["?metric=bogus", "?metric=heart_rate_bpm", "?user=18&metric=fat_ratio_pct"]) {
      const html = await h.page(query);
      assert.doesNotMatch(html, /class="verdict"/, query);
      assert.doesNotMatch(html, /<a class="back"/, query);
    }
    assert.match(await h.page("?metric=bogus"), /<section class="weight-hero">/);
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
    assert.match(hero(html), /99\.2 kg/);
    assert.match(row(html, "heart_rate_bpm"), /70 bpm/);
    assert.match(row(html, "fat_ratio_pct"), /30\.0 %/);
    assert.match(html, /<div class="composition"/);
  } finally {
    h.cleanup();
  }
});

test("a weight-only user gets the header, the chart and BMI, but no composition bar", async () => {
  const h = await harness();
  try {
    await h.reading(17, now() - DAY, [{ type: 1, value: 80000, unit: -3 }]);
    const html = await h.page();
    assert.match(hero(html), /80\.0 kg/);
    assert.doesNotMatch(hero(html), /[▲▼=] /); // Only one weigh-in: no change.
    assert.doesNotMatch(html, /<div class="composition"/);
    assert.deepEqual([...html.matchAll(/data-metric="([^"]+)"/g)].map((m) => m[1]), ["bmi"]);
  } finally {
    h.cleanup();
  }
});

test("range buttons filter the charts and keep the user", async () => {
  const h = await harness();
  try {
    for (const age of [1, 20, 60, 200, 500])
      await h.reading(17, now() - age * DAY, [{ type: 1, value: 100000 + age, unit: -3 }]);
    assert.equal(dots(await h.page(), "Weight"), 3); // Default: 3 months.
    assert.equal(dots(await h.page("?range=1m"), "Weight"), 2);
    assert.equal(dots(await h.page("?range=1y"), "Weight"), 4);
    assert.equal(dots(await h.page("?range=all"), "Weight"), 5);
    assert.equal(dots(await h.page("?range=forever"), "Weight"), 3);
    const html = await h.page("?user=17&range=1y");
    assert.match(html, /href="\/\?user=17&amp;range=all"/);
    assert.match(html, /<a[^>]*href="\/\?user=17&amp;range=1y"[^>]*aria-current="page"/);
    // The header always shows the latest reading, whatever the chart range.
    assert.match(hero(await h.page("?range=1m")), /100\.0 kg/);
    assert.equal(dots(await h.page("?metric=bmi&range=all"), "BMI"), 5);
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
    assert.match(hero(html), /220\.5 lb/);
    assert.match(hero(html), /▼ 1\.0 %/); // A percentage, whatever the unit.
    assert.match(row(html, "muscle_mass_kg"), /146\.4 lb/);
    assert.match(row(html, "fat_ratio_pct"), /30\.0 %/); // Percentages are unit-free.
    assert.match(await h.page("?metric=muscle_mass_kg"), /<p class="hero-value">146\.4 lb<\/p>/);
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
    assert.doesNotMatch(html, /<svg|weight-hero|class="measure"/);
    await h.reading(17, now() - DAY, [{ type: 1, value: 80000, unit: -3 }], { measures_json: "{broken" });
    await h.reading(17, now() - 2 * DAY, [{ type: 1, value: 81000, unit: -3 }]);
    html = await h.page();
    assert.match(hero(html), /81\.0 kg/);
    // Unassigned readings belong to nobody's overview.
    await h.reading(null, now(), [{ type: 1, value: 50000, unit: -3 }]);
    assert.doesNotMatch(await h.page(), /50\.0 kg/);
  } finally {
    h.cleanup();
  }
});