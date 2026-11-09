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
  "Visceral fat: the Withings app scale, out of 20 for everyone (under 5 good, 5–10 high, above 10 very high).",
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

/** A rated metric's bands: `edges` separate `bands` (one more band than
 * edges). With `inclusive` (for every edge, or per edge), a value on an edge
 * belongs to the band below. */
export type Scale = {
  edges: number[];
  bands: Rating[];
  basis: string;
  inclusive?: boolean | boolean[];
};
const band = (label: string, tone: Rating["tone"]): Rating => ({ label, tone });
const SEX = ["men", "women"];

/** Reference scale of a metric for this person, or null where none applies. */
export function scaleFor(
  key: string,
  profile: Profile,
  time: number,
): Scale | null {
  switch (key) {
    case "fat_ratio_pct": {
      const age = ageAt(profile, time);
      const row =
        age === null
          ? undefined
          : GALLAGHER[profile.sex]?.find(([from, to]) => age >= from && age < to);
      if (!row) return null;
      return {
        edges: [...row[2]],
        bands: [band("Low", "warn"), band("Healthy", "good"), band("High", "warn"), band("Very High", "bad")],
        basis: `Reference values for ${SEX[profile.sex]} ${row[0]}–${row[1] - 1} (Gallagher et al. 2000)`,
      };
    }
    case "bmi":
      return {
        edges: [18.5, 25, 30],
        bands: [band("Underweight", "warn"), band("Healthy", "good"), band("Overweight", "warn"), band("Obese", "bad")],
        basis: "World Health Organization adult categories",
      };
    case "visceral_fat_index":
      return {
        edges: [5, 10],
        bands: [band("Good", "good"), band("High", "warn"), band("Very High", "bad")],
        basis: "Withings scale out of 20, the same for everyone",
        inclusive: [false, true], // Under 5 good, 5 to 10 high.
      };
    case "water_pct": {
      const range = WATER[profile.sex];
      if (!range) return null;
      return {
        edges: [...range],
        bands: [band("Low", "warn"), band("Healthy", "good"), band("High", "warn")],
        basis: `Commonly cited adult range for ${SEX[profile.sex]}`,
        inclusive: true,
      };
    }
    case "heart_rate_bpm":
      return {
        edges: [60, 100],
        bands: [band("Low", "warn"), band("Normal", "good"), band("High", "warn")],
        basis: "American Heart Association adult resting range",
        inclusive: true,
      };
    case "metabolic_age_years": {
      const age = ageAt(profile, time);
      if (age === null) return null;
      return {
        edges: [age],
        bands: [band("Good", "good"), band("Above Your Age", "warn")],
        basis: `Compared with your age (${age})`,
        inclusive: true,
      };
    }
    default:
      return null;
  }
}

function bandIndex(scale: Scale, value: number): number {
  const i = scale.edges.findIndex((edge, j) =>
    (Array.isArray(scale.inclusive) ? scale.inclusive[j] : scale.inclusive)
      ? value <= edge
      : value < edge,
  );
  return i === -1 ? scale.edges.length : i;
}

/** Reference rating of a value, or null where no reference applies. */
export function rate(
  key: string,
  value: number,
  profile: Profile,
  time: number,
): Rating | null {
  const scale = scaleFor(key, profile, time);
  return scale ? scale.bands[bandIndex(scale, value)] : null;
}

/** Where a value sits on an equal-width range bar, 0 (left) to 1 (right).
 * Open outer bands take their neighbour's width (a quarter of the edge with
 * a single edge) and pin values beyond it to the end. */
export function markerPosition(scale: Scale, value: number): number {
  const { edges } = scale;
  const n = edges.length + 1;
  const i = bandIndex(scale, value);
  const width = (edges.length > 1
    ? i === 0
      ? edges[1] - edges[0]
      : edges[edges.length - 1] - edges[edges.length - 2]
    : Math.abs(edges[0]) / 4) || 1;
  const low = i === 0 ? edges[0] - width : edges[i - 1];
  const high = i === edges.length ? edges[i - 1] + width : edges[i];
  const within = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return (i + within) / n;
}

/** One-line verdict for a rated value, e.g. "Your BMI is in the obese range". */
export function verdict(key: string, label: string, rating: Rating): string {
  const name = label === "BMI" ? label : label.toLowerCase();
  if (key === "metabolic_age_years")
    return rating.tone === "good"
      ? `Your ${name} is at or below your age`
      : `Your ${name} is above your age`;
  return `Your ${name} is in the ${rating.label.toLowerCase()} range`;
}

/** Muscle, fat and bone as % of weight, from the newest reading with all three. */
export function compositionOf(
  rows: Record<string, any>[],
  profile: Profile,
): { muscle: number; fat: number; bone: number; time: number } | null {
  let best: { muscle: number; fat: number; bone: number; time: number } | null = null;
  for (const row of rows) {
    let v: Record<string, number>;
    try {
      v = readingValues(row, profile);
    } catch {
      continue;
    }
    const time = readingTime(row);
    if (
      v.weight_kg > 0 &&
      v.muscle_mass_kg !== undefined &&
      v.fat_mass_kg !== undefined &&
      v.bone_mass_kg !== undefined &&
      (!best || time > best.time)
    )
      best = {
        muscle: (v.muscle_mass_kg / v.weight_kg) * 100,
        fat: (v.fat_mass_kg / v.weight_kg) * 100,
        bone: (v.bone_mass_kg / v.weight_kg) * 100,
        time,
      };
  }
  return best;
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
