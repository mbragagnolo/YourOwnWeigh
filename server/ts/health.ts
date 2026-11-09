/** Health overview: per-reading values, derived metrics and reference ratings.
 * Pure functions over stored reading rows; the dashboard renders their output.
 * Ranges are general-population references for information, not medical advice.
 */
import { METRICS, decimalValue, type Measure } from "./metrics.ts";

export type Profile = {
  sex: number; // 0 male, 1 female (as stored by the Users form)
  heightCm: number | null;
  birthDate: string | null; // YYYY-MM-DD
  ageYears: number | null;
};
export type Point = { readingId: number; time: number; value: number };
export type Rating = { label: string; tone: "good" | "warn" | "bad" };
export type OverviewMetric = {
  key: string;
  label: string;
  unit: string;
  kind: "mass" | "percent" | "plain"; // mass follows the display weight unit
  decimals: number;
};

/** Display order of the overview tiles and charts. */
export const OVERVIEW: OverviewMetric[] = [
  { key: "weight_kg", label: "Weight", unit: "kg", kind: "mass", decimals: 1 },
  { key: "bmi", label: "BMI", unit: "", kind: "plain", decimals: 1 },
  { key: "fat_ratio_pct", label: "Body Fat", unit: "%", kind: "percent", decimals: 1 },
  { key: "fat_mass_kg", label: "Fat Mass", unit: "kg", kind: "mass", decimals: 1 },
  { key: "fat_free_mass_kg", label: "Fat-Free Mass", unit: "kg", kind: "mass", decimals: 1 },
  { key: "muscle_mass_kg", label: "Muscle Mass", unit: "kg", kind: "mass", decimals: 1 },
  { key: "water_pct", label: "Body Water", unit: "%", kind: "percent", decimals: 1 },
  { key: "water_mass_kg", label: "Water Mass", unit: "kg", kind: "mass", decimals: 1 },
  { key: "bone_mass_kg", label: "Bone Mass", unit: "kg", kind: "mass", decimals: 1 },
  { key: "visceral_fat_index", label: "Visceral Fat", unit: "", kind: "plain", decimals: 1 },
  { key: "basal_metabolic_rate_kcal", label: "Basal Metabolic Rate", unit: "kcal/day", kind: "plain", decimals: 0 },
  { key: "metabolic_age_years", label: "Metabolic Age", unit: "years", kind: "plain", decimals: 0 },
  { key: "heart_rate_bpm", label: "Heart Rate", unit: "bpm", kind: "plain", decimals: 0 },
];

/** Sources behind every rating and shaded band, shown on the page. */
export const REFERENCE_NOTES = [
  "Body fat: Gallagher et al. 2000, healthy ranges by sex and age (20–79).",
  "BMI: World Health Organization adult categories.",
  "Body water: commonly cited adult ranges (men 50–65 %, women 45–60 %).",
  "Visceral fat: common scale index convention (1–12 healthy).",
  "Heart rate: American Heart Association adult resting range (60–100 bpm).",
  "Metabolic age: compared with your age.",
];

// [age from, age to (exclusive), [healthy from, high from, very high from]]
type FatBands = Array<[number, number, [number, number, number]]>;
const GALLAGHER: Record<number, FatBands> = {
  0: [
    [20, 40, [8, 20, 25]],
    [40, 60, [11, 22, 28]],
    [60, 80, [13, 25, 30]],
  ],
  1: [
    [20, 40, [21, 33, 39]],
    [40, 60, [23, 34, 40]],
    [60, 80, [24, 36, 42]],
  ],
};
const WATER: Record<number, [number, number]> = { 0: [50, 65], 1: [45, 60] };

const KEY_BY_TYPE = new Map(
  METRICS.filter((m) => OVERVIEW.some((o) => o.key === m.key)).map((m) => [
    m.type,
    m.key,
  ]),
);

export function readingTime(row: Record<string, any>): number {
  return Number(
    row.time_quality === "trusted" ? row.meastime : row.first_received_at,
  );
}

/** Whole-body values of one reading, plus body fat %, water % and BMI. */
export function readingValues(
  row: Record<string, any>,
  profile: Profile,
): Record<string, number> {
  const measures: Measure[] = JSON.parse(row.measures_json);
  if (!Array.isArray(measures)) throw new Error("Invalid stored measures");
  const values: Record<string, number> = {};
  for (const [type, key] of KEY_BY_TYPE) {
    const found = measures.filter((m) => m.type === type);
    // Segmented readings carry one value per body position: not whole-body.
    if (found.length === 1)
      values[key] = Number(decimalValue(found[0].value, found[0].unit));
  }
  if (values.weight_kg === undefined && row.weight_value != null)
    values.weight_kg = Number(
      decimalValue(Number(row.weight_value), Number(row.weight_unit)),
    );
  const weight = values.weight_kg;
  if (weight > 0) {
    if (values.fat_ratio_pct === undefined && values.fat_mass_kg !== undefined)
      values.fat_ratio_pct = (values.fat_mass_kg / weight) * 100;
    if (values.water_mass_kg !== undefined)
      values.water_pct = (values.water_mass_kg / weight) * 100;
    if (profile.heightCm && profile.heightCm > 0)
      values.bmi = weight / (profile.heightCm / 100) ** 2;
  }
  return values;
}

/** Age at a moment: whole years from the birth date, else the stored age. */
export function ageAt(profile: Profile, time: number): number | null {
  const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(profile.birthDate ?? "");
  if (birth) {
    const [y, m, d] = birth.slice(1).map(Number);
    const at = new Date(time * 1000);
    if (!Number.isNaN(Date.UTC(y, m - 1, d)) && m >= 1 && m <= 12) {
      let age = at.getUTCFullYear() - y;
      if (
        at.getUTCMonth() + 1 < m ||
        (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)
      )
        age--;
      return age;
    }
  }
  return profile.ageYears ?? null;
}

function fatBands(profile: Profile, time: number) {
  const age = ageAt(profile, time);
  if (age === null) return null;
  return (
    GALLAGHER[profile.sex]?.find(([from, to]) => age >= from && age < to)?.[2] ??
    null
  );
}

/** Reference rating of a value, or null where no reference applies. */
export function rate(
  key: string,
  value: number,
  profile: Profile,
  time: number,
): Rating | null {
  switch (key) {
    case "fat_ratio_pct": {
      const bands = fatBands(profile, time);
      if (!bands) return null;
      const [healthy, high, veryHigh] = bands;
      if (value < healthy) return { label: "Low", tone: "warn" };
      if (value < high) return { label: "Healthy", tone: "good" };
      if (value < veryHigh) return { label: "High", tone: "warn" };
      return { label: "Very High", tone: "bad" };
    }
    case "bmi":
      if (value < 18.5) return { label: "Underweight", tone: "warn" };
      if (value < 25) return { label: "Healthy", tone: "good" };
      if (value < 30) return { label: "Overweight", tone: "warn" };
      return { label: "Obese", tone: "bad" };
    case "visceral_fat_index":
      return value < 13
        ? { label: "Healthy", tone: "good" }
        : { label: "High", tone: "bad" };
    case "water_pct": {
      const range = WATER[profile.sex];
      if (!range) return null;
      if (value < range[0]) return { label: "Low", tone: "warn" };
      if (value <= range[1]) return { label: "Healthy", tone: "good" };
      return { label: "High", tone: "warn" };
    }
    case "heart_rate_bpm":
      if (value < 60) return { label: "Low", tone: "warn" };
      if (value <= 100) return { label: "Normal", tone: "good" };
      return { label: "High", tone: "warn" };
    case "metabolic_age_years": {
      const age = ageAt(profile, time);
      if (age === null) return null;
      return value <= age
        ? { label: "Good", tone: "good" }
        : { label: "Above Your Age", tone: "warn" };
    }
    default:
      return null;
  }
}

/** Healthy range to shade behind a chart; the same figures as rate(). */
export function healthyBand(
  key: string,
  profile: Profile,
  time: number,
): { low: number; high: number } | null {
  if (key === "fat_ratio_pct") {
    const bands = fatBands(profile, time);
    return bands ? { low: bands[0], high: bands[1] } : null;
  }
  if (key === "bmi") return { low: 18.5, high: 25 };
  if (key === "water_pct") {
    const range = WATER[profile.sex];
    return range ? { low: range[0], high: range[1] } : null;
  }
  return null;
}

/** Time series per metric, oldest first. Malformed rows are skipped. */
export function series(
  rows: Record<string, any>[],
  profile: Profile,
): Record<string, Point[]> {
  const out: Record<string, Point[]> = {};
  for (const row of rows) {
    let values: Record<string, number>;
    try {
      values = readingValues(row, profile);
    } catch {
      continue;
    }
    const time = readingTime(row);
    for (const [key, value] of Object.entries(values))
      (out[key] ??= []).push({ readingId: Number(row.id), time, value });
  }
  for (const points of Object.values(out))
    points.sort((a, b) => a.time - b.time || a.readingId - b.readingId);
  return out;
}

/** The newest point of a series and the one before it. */
export function latest(
  points: Point[] | undefined,
): { latest: Point; previous: Point | null } | null {
  if (!points?.length) return null;
  return {
    latest: points[points.length - 1],
    previous: points.length > 1 ? points[points.length - 2] : null,
  };
}
