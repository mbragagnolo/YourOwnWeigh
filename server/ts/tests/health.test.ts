import test from "node:test";
import assert from "node:assert/strict";
import {
  OVERVIEW,
  ageAt,
  compositionOf,
  markerPosition,
  scaleFor,
  verdict,
  healthyBand,
  latest,
  rate,
  readingValues,
  series,
  type Profile,
} from "../health.ts";

const NOV_2026 = Date.UTC(2026, 10, 9) / 1000;
const man40: Profile = { sex: 0, heightCm: 180, birthDate: null, ageYears: 40 };
const woman35: Profile = { sex: 1, heightCm: 160, birthDate: null, ageYears: 35 };
const row = (measures: object[], extra: Record<string, unknown> = {}) => ({
  id: 1,
  meastime: NOV_2026,
  first_received_at: NOV_2026 + 30,
  time_quality: "trusted",
  measures_json: JSON.stringify(measures),
  ...extra,
});
// A WBS13 composition group (synthetic person, real wire shape).
const composition = [
  { value: 100000, type: 1, unit: -3 },
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

test("reading values include known metrics and derived percentages and BMI", () => {
  const v = readingValues(row(composition), man40);
  assert.equal(v.weight_kg, 100);
  assert.equal(v.fat_mass_kg, 30);
  assert.equal(v.muscle_mass_kg, 66.4);
  assert.equal(v.visceral_fat_index, 6.4);
  assert.equal(v.metabolic_age_years, 44);
  assert.ok(Math.abs(v.fat_ratio_pct - 30) < 0.001);
  assert.ok(Math.abs(v.water_pct - 46.8) < 0.001);
  assert.ok(Math.abs(v.bmi - 100 / 1.8 ** 2) < 1e-9);
  assert.equal("189" in v, false); // Unknown sensor types are not overview metrics.
});

test("a scale-provided fat ratio wins; missing inputs omit derived values", () => {
  const v = readingValues(
    row([{ value: 1000, type: 1, unit: -1 }, { value: 2500, type: 8, unit: -2 }, { value: 280, type: 6, unit: -1 }]),
    { ...man40, heightCm: null },
  );
  assert.equal(v.fat_ratio_pct, 28);
  assert.equal("bmi" in v, false);
  assert.equal("water_pct" in v, false);
  const heart = readingValues(row([{ value: 70, type: 11, unit: 0 }]), man40);
  assert.deepEqual(Object.keys(heart), ["heart_rate_bpm"]);
});

test("segmented metrics with several positions are not treated as whole-body values", () => {
  const v = readingValues(
    row([
      { value: 80000, type: 1, unit: -3 },
      { value: 900, type: 76, unit: -2, position: 2 },
      { value: 910, type: 76, unit: -2, position: 3 },
    ]),
    man40,
  );
  assert.equal("muscle_mass_kg" in v, false);
});

test("body fat is rated against Gallagher 2000 by sex and age band", () => {
  assert.deepEqual(rate("fat_ratio_pct", 30, man40, NOV_2026), { label: "Very High", tone: "bad" });
  assert.deepEqual(rate("fat_ratio_pct", 15, man40, NOV_2026), { label: "Healthy", tone: "good" });
  assert.deepEqual(rate("fat_ratio_pct", 10, man40, NOV_2026), { label: "Low", tone: "warn" });
  assert.deepEqual(rate("fat_ratio_pct", 25, man40, NOV_2026), { label: "High", tone: "warn" });
  assert.deepEqual(rate("fat_ratio_pct", 30, woman35, NOV_2026), { label: "Healthy", tone: "good" });
  // Band edges: the lower edge of a band belongs to that band.
  const man25 = { ...man40, ageYears: 25 };
  assert.equal(rate("fat_ratio_pct", 8, man25, NOV_2026)?.label, "Healthy");
  assert.equal(rate("fat_ratio_pct", 20, man25, NOV_2026)?.label, "High");
  // Outside the 20–79 years the reference covers: unrated.
  assert.equal(rate("fat_ratio_pct", 20, { ...man40, ageYears: 19 }, NOV_2026), null);
  assert.equal(rate("fat_ratio_pct", 20, { ...man40, ageYears: 80 }, NOV_2026), null);
  assert.equal(rate("fat_ratio_pct", 20, { ...man40, ageYears: null }, NOV_2026), null);
});

test("BMI, visceral fat, water, heart rate and metabolic age ratings", () => {
  assert.deepEqual(rate("bmi", 31, man40, NOV_2026), { label: "Obese", tone: "bad" });
  assert.deepEqual(rate("bmi", 27, man40, NOV_2026), { label: "Overweight", tone: "warn" });
  assert.deepEqual(rate("bmi", 18.5, man40, NOV_2026), { label: "Healthy", tone: "good" });
  assert.deepEqual(rate("bmi", 18.4, man40, NOV_2026), { label: "Underweight", tone: "warn" });
  // Withings app scale (out of 20, same for both sexes): Good < 5, High 5–10, Very High above 10.
  assert.deepEqual(rate("visceral_fat_index", 4.9, man40, NOV_2026), { label: "Good", tone: "good" });
  assert.deepEqual(rate("visceral_fat_index", 2.4, woman35, NOV_2026), { label: "Good", tone: "good" });
  assert.deepEqual(rate("visceral_fat_index", 5, man40, NOV_2026), { label: "High", tone: "warn" });
  assert.deepEqual(rate("visceral_fat_index", 6.4, man40, NOV_2026), { label: "High", tone: "warn" });
  assert.deepEqual(rate("visceral_fat_index", 10, man40, NOV_2026), { label: "High", tone: "warn" });
  assert.deepEqual(rate("visceral_fat_index", 10.1, man40, NOV_2026), { label: "Very High", tone: "bad" });
  assert.deepEqual(rate("water_pct", 46.8, man40, NOV_2026), { label: "Low", tone: "warn" });
  assert.deepEqual(rate("water_pct", 50, woman35, NOV_2026), { label: "Healthy", tone: "good" });
  assert.deepEqual(rate("water_pct", 66, man40, NOV_2026), { label: "High", tone: "warn" });
  assert.deepEqual(rate("heart_rate_bpm", 70, man40, NOV_2026), { label: "Normal", tone: "good" });
  assert.deepEqual(rate("heart_rate_bpm", 55, man40, NOV_2026), { label: "Low", tone: "warn" });
  assert.deepEqual(rate("heart_rate_bpm", 101, man40, NOV_2026), { label: "High", tone: "warn" });
  assert.deepEqual(rate("metabolic_age_years", 41, { ...man40, ageYears: 37.2 }, NOV_2026), {
    label: "Above Your Age",
    tone: "warn",
  });
  assert.deepEqual(rate("metabolic_age_years", 37, { ...man40, ageYears: 37.2 }, NOV_2026), {
    label: "Good",
    tone: "good",
  });
  for (const key of ["weight_kg", "muscle_mass_kg", "bone_mass_kg", "basal_metabolic_rate_kcal", "fat_mass_kg"])
    assert.equal(rate(key, 50, man40, NOV_2026), null, key);
});

test("age comes from the birth date at the reading time, else the stored age", () => {
  const born = { ...man40, birthDate: "1989-11-10", ageYears: 99 };
  assert.equal(ageAt(born, NOV_2026), 36); // One day before the birthday.
  assert.equal(ageAt(born, NOV_2026 + 86400), 37);
  assert.equal(ageAt(man40, NOV_2026), 40);
  assert.equal(ageAt({ ...man40, ageYears: null }, NOV_2026), null);
  assert.equal(ageAt({ ...man40, birthDate: "not a date", ageYears: 33 }, NOV_2026), 33);
});

test("healthy bands match the ratings and exist only for shaded metrics", () => {
  assert.deepEqual(healthyBand("fat_ratio_pct", man40, NOV_2026), { low: 11, high: 22 });
  assert.deepEqual(healthyBand("bmi", man40, NOV_2026), { low: 18.5, high: 25 });
  assert.deepEqual(healthyBand("water_pct", woman35, NOV_2026), { low: 45, high: 60 });
  assert.equal(healthyBand("muscle_mass_kg", man40, NOV_2026), null);
  assert.equal(healthyBand("heart_rate_bpm", man40, NOV_2026), null);
  assert.equal(healthyBand("fat_ratio_pct", { ...man40, ageYears: 85 }, NOV_2026), null);
});

test("series are per metric, ascending, use trusted time and skip malformed rows", () => {
  const rows = [
    row([{ value: 80000, type: 1, unit: -3 }], { id: 3, meastime: NOV_2026 + 200 }),
    row([{ value: 72, type: 11, unit: 0 }], { id: 2, meastime: NOV_2026 + 100 }),
    row([{ value: 81000, type: 1, unit: -3 }], {
      id: 1,
      meastime: 0,
      time_quality: "untrusted",
      first_received_at: NOV_2026 + 50,
    }),
    { ...row([]), id: 4, measures_json: "{broken" },
  ];
  const s = series(rows, man40);
  assert.deepEqual(
    s.weight_kg.map((p) => [p.readingId, p.time, p.value]),
    [
      [1, NOV_2026 + 50, 81],
      [3, NOV_2026 + 200, 80],
    ],
  );
  assert.deepEqual(s.heart_rate_bpm.map((p) => p.readingId), [2]);
  assert.equal(s.fat_mass_kg, undefined);
});

test("latest and previous come from the same metric, ignoring rows without it", () => {
  const s = series(
    [
      row([{ value: 80000, type: 1, unit: -3 }, { value: 2000, type: 8, unit: -2 }], { id: 1, meastime: NOV_2026 }),
      row([{ value: 79000, type: 1, unit: -3 }, { value: 1900, type: 8, unit: -2 }], { id: 2, meastime: NOV_2026 + 10 }),
      row([{ value: 78500, type: 1, unit: -3 }], { id: 3, meastime: NOV_2026 + 20 }),
    ],
    man40,
  );
  const fat = latest(s.fat_mass_kg)!;
  assert.equal(fat.latest.readingId, 2);
  assert.equal(fat.previous!.readingId, 1);
  assert.equal(latest(s.weight_kg)!.latest.value, 78.5);
  assert.equal(latest([s.weight_kg[0]])!.previous, null);
  assert.equal(latest([]), null);
});

test("overview metrics are ordered, unique and say how they are displayed", () => {
  const keys = OVERVIEW.map((m) => m.key);
  assert.equal(keys[0], "weight_kg");
  assert.equal(new Set(keys).size, keys.length);
  for (const key of ["bmi", "fat_ratio_pct", "water_pct", "heart_rate_bpm", "visceral_fat_index"])
    assert.ok(keys.includes(key), key);
  for (const m of OVERVIEW) assert.ok(["mass", "percent", "plain"].includes(m.kind), m.key);
});

test("scales give each rated metric its band edges, names and reference basis", () => {
  const fat = scaleFor("fat_ratio_pct", man40, NOV_2026)!;
  assert.deepEqual(fat.edges, [11, 22, 28]);
  assert.deepEqual(fat.bands.map((b) => b.label), ["Low", "Healthy", "High", "Very High"]);
  assert.match(fat.basis, /men 40–59/);
  assert.match(fat.basis, /Gallagher/);
  assert.match(scaleFor("fat_ratio_pct", woman35, NOV_2026)!.basis, /women 20–39/);
  assert.equal(scaleFor("fat_ratio_pct", { ...man40, ageYears: 85 }, NOV_2026), null);
  assert.deepEqual(scaleFor("bmi", man40, NOV_2026)!.edges, [18.5, 25, 30]);
  assert.deepEqual(scaleFor("visceral_fat_index", woman35, NOV_2026)!.edges, [5, 10]);
  assert.deepEqual(scaleFor("water_pct", man40, NOV_2026)!.edges, [50, 65]);
  assert.match(scaleFor("water_pct", woman35, NOV_2026)!.basis, /women/);
  assert.deepEqual(scaleFor("heart_rate_bpm", man40, NOV_2026)!.edges, [60, 100]);
  const age = scaleFor("metabolic_age_years", man40, NOV_2026)!;
  assert.deepEqual(age.edges, [40]);
  assert.deepEqual(age.bands.map((b) => b.label), ["Good", "Above Your Age"]);
  for (const key of ["weight_kg", "muscle_mass_kg", "bone_mass_kg", "basal_metabolic_rate_kcal"])
    assert.equal(scaleFor(key, man40, NOV_2026), null, key);
});

test("ratings and scales always agree, edges included", () => {
  const cases: Record<string, number[]> = {
    fat_ratio_pct: [5, 11, 21.9, 22, 28, 40],
    bmi: [17, 18.5, 24.9, 25, 30, 41],
    visceral_fat_index: [1, 4.9, 5, 10, 10.1, 19],
    water_pct: [40, 50, 65, 65.1],
    heart_rate_bpm: [45, 60, 100, 101],
    metabolic_age_years: [30, 40, 41],
  };
  for (const [key, values] of Object.entries(cases)) {
    const scale = scaleFor(key, man40, NOV_2026)!;
    for (const value of values) {
      const position = markerPosition(scale, value);
      const band = Math.min(scale.bands.length - 1, Math.floor(position * scale.bands.length));
      const rating = rate(key, value, man40, NOV_2026)!;
      assert.ok(position >= 0 && position <= 1, `${key} ${value}`);
      // A value on an edge sits on the boundary; elsewhere the marker is inside its band.
      if (!scale.edges.includes(value))
        assert.equal(scale.bands[band].label, rating.label, `${key} ${value}`);
    }
  }
});

test("range bar markers sit proportionally inside equal-width segments", () => {
  const bmi = scaleFor("bmi", man40, NOV_2026)!;
  assert.equal(markerPosition(bmi, 25), 0.5);
  assert.equal(markerPosition(bmi, 21.75), 0.375);
  // Open outer bands take the neighbouring band's width, then pin to the end.
  assert.ok(Math.abs(markerPosition(bmi, 30.9) - 0.795) < 1e-9);
  assert.equal(markerPosition(bmi, 50), 1);
  assert.equal(markerPosition(bmi, 15.25), 0.125);
  assert.equal(markerPosition(bmi, 10), 0);
  // One edge only (metabolic age): each side spans a quarter of the edge value.
  const age = scaleFor("metabolic_age_years", man40, NOV_2026)!;
  assert.equal(markerPosition(age, 40), 0.5);
  assert.ok(Math.abs(markerPosition(age, 41) - 0.55) < 1e-9);
});

test("verdicts read as a sentence", () => {
  assert.equal(verdict("fat_ratio_pct", "Body Fat", { label: "Very High", tone: "bad" }), "Your body fat is in the very high range");
  assert.equal(verdict("bmi", "BMI", { label: "Obese", tone: "bad" }), "Your BMI is in the obese range");
  assert.equal(verdict("visceral_fat_index", "Visceral Fat", { label: "Good", tone: "good" }), "Your visceral fat is in the good range");
  assert.equal(verdict("metabolic_age_years", "Metabolic Age", { label: "Above Your Age", tone: "warn" }), "Your metabolic age is above your age");
  assert.equal(verdict("metabolic_age_years", "Metabolic Age", { label: "Good", tone: "good" }), "Your metabolic age is at or below your age");
});

test("composition shares come from the newest reading that has muscle, fat and bone", () => {
  const share = compositionOf([row(composition, { id: 1 })], man40)!;
  assert.ok(Math.abs(share.muscle - (66.4 / 100) * 100) < 1e-9);
  assert.ok(Math.abs(share.fat - (30 / 100) * 100) < 1e-9);
  assert.ok(Math.abs(share.bone - (3.6 / 100) * 100) < 1e-9);
  assert.equal(share.time, NOV_2026);
  // A newer weight-only reading does not hide it.
  const later = row([{ value: 99000, type: 1, unit: -3 }], { id: 2, meastime: NOV_2026 + 86400 });
  assert.equal(compositionOf([row(composition, { id: 1 }), later], man40)!.time, NOV_2026);
  const noBone = composition.filter((m) => m.type !== 88);
  assert.equal(compositionOf([row(noBone), later], man40), null);
  assert.equal(compositionOf([row([], { measures_json: "{bad" })], man40), null);
});