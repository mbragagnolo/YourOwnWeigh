/** Goal plans: per-user milestone targets, judged against smoothed readings.
 * Pure functions; the Goals page renders their output. A plan is a list of
 * dated milestones; the target on any day is the straight line between the
 * milestones either side of it (held flat before the first and after the last).
 * Readings are reduced to one value per local day (the first, normally the
 * morning weigh-in) and judged on a rolling average, never a single reading.
 */
import type { Point } from "./health.ts";

export type GoalMetric = {
  key: string;
  label: string;
  /** Column heading in the milestone table and form. */
  column: string;
  /** Days in the rolling average this metric is judged on. */
  window: number;
  /** Which side of the target counts as on track. */
  better: "lower" | "higher";
  /** Off target by at most this much reads as "close". */
  tolerance: number;
  min: number;
  max: number;
  mass: boolean;
  suffix: string;
  decimals: number;
};

export const GOAL_METRICS: GoalMetric[] = [
  { key: "weight_kg", label: "Weight", column: "Weight (kg)", window: 7, better: "lower", tolerance: 0.5, min: 1, max: 400, mass: true, suffix: " kg", decimals: 1 },
  { key: "fat_ratio_pct", label: "Body Fat", column: "Body fat (%)", window: 28, better: "lower", tolerance: 0.5, min: 1, max: 75, mass: false, suffix: " %", decimals: 1 },
  { key: "fat_mass_kg", label: "Fat Mass", column: "Fat mass (kg)", window: 28, better: "lower", tolerance: 0.5, min: 0.5, max: 300, mass: true, suffix: " kg", decimals: 1 },
  { key: "fat_free_mass_kg", label: "Fat-Free Mass", column: "Fat-free mass ≥ (kg)", window: 28, better: "higher", tolerance: 0.5, min: 1, max: 300, mass: true, suffix: " kg", decimals: 1 },
  { key: "muscle_mass_kg", label: "Muscle Mass", column: "Muscle ≥ (kg)", window: 28, better: "higher", tolerance: 0.5, min: 1, max: 300, mass: true, suffix: " kg", decimals: 1 },
  { key: "visceral_fat_index", label: "Visceral Fat", column: "Visceral ≤", window: 28, better: "lower", tolerance: 0.3, min: 0, max: 30, mass: false, suffix: "", decimals: 1 },
  { key: "heart_rate_bpm", label: "Heart Rate", column: "Heart rate ≤ (bpm)", window: 28, better: "lower", tolerance: 2, min: 30, max: 200, mass: false, suffix: " bpm", decimals: 0 },
  // From a linked Garmin watch.
  { key: "resting_hr_bpm", label: "Resting Heart Rate", column: "Resting HR ≤ (bpm, watch)", window: 7, better: "lower", tolerance: 1, min: 30, max: 120, mass: false, suffix: " bpm", decimals: 0 },
  { key: "steps", label: "Steps", column: "Steps ≥ (watch)", window: 7, better: "higher", tolerance: 500, min: 0, max: 60000, mass: false, suffix: "", decimals: 0 },
  { key: "vo2max", label: "VO2 Max", column: "VO2 max ≥ (watch)", window: 28, better: "higher", tolerance: 0.5, min: 10, max: 90, mass: false, suffix: "", decimals: 0 },
];

export type Milestone = { date: string; targets: Record<string, number> };
export type Plan = { milestones: Milestone[] };
export type Plans = Record<string, Plan>;
export const MAX_MILESTONES = 12;
const DAY = 86400;

/** Midday UTC of a YYYY-MM-DD date, or null when it is not a real date. */
export function dateTime(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, 12);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return null;
  return t / 1000;
}

/** Throws a user-facing message unless the plan is well formed. */
export function validatePlan(plan: unknown): Plan {
  const milestones = (plan as Plan)?.milestones;
  if (!Array.isArray(milestones) || milestones.length < 2 || milestones.length > MAX_MILESTONES)
    throw new Error(`A plan needs between 2 and ${MAX_MILESTONES} milestones`);
  let previous = -Infinity;
  const out: Milestone[] = [];
  for (const m of milestones) {
    const time = typeof m?.date === "string" ? dateTime(m.date) : null;
    if (time === null) throw new Error("Each milestone needs a date (YYYY-MM-DD)");
    if (time <= previous) throw new Error("Milestone dates must be in order, each after the last");
    previous = time;
    const targets: Record<string, number> = {};
    for (const [key, value] of Object.entries(m.targets ?? {})) {
      const metric = GOAL_METRICS.find((g) => g.key === key);
      if (!metric) throw new Error("Unknown goal measure");
      if (typeof value !== "number" || !Number.isFinite(value) || value < metric.min || value > metric.max)
        throw new Error(`${metric.label} on ${m.date} must be between ${metric.min} and ${metric.max}`);
      targets[key] = value;
    }
    if (!Object.keys(targets).length) throw new Error(`Give the milestone on ${m.date} at least one target`);
    out.push({ date: m.date, targets });
  }
  for (const metric of GOAL_METRICS) {
    const set = out.filter((m) => metric.key in m.targets).length;
    if (set === 1) throw new Error(`${metric.label} needs targets on at least two milestones, or none`);
  }
  return { milestones: out };
}

export function parsePlans(stored: string | null): Plans {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const plans: Plans = {};
    for (const [user, plan] of Object.entries(parsed)) {
      try {
        plans[user] = validatePlan(plan);
      } catch {
        // A damaged entry is dropped rather than breaking the page.
      }
    }
    return plans;
  } catch {
    return {};
  }
}

/** Milestones from the Goals form: rows `date_N` plus `<metric>_N`. Rows
 * without a date are ignored; no dated rows at all means "remove the plan". */
export function planFromForm(get: (name: string) => string): Plan | null {
  const milestones: Milestone[] = [];
  for (let i = 0; i < MAX_MILESTONES + 4; i++) {
    const date = get(`date_${i}`).trim();
    const targets: Record<string, number> = {};
    for (const metric of GOAL_METRICS) {
      const raw = get(`${metric.key}_${i}`).trim().replace(",", ".");
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${metric.label} must be a number`);
      targets[metric.key] = value;
    }
    if (!date) {
      if (Object.keys(targets).length) throw new Error("Each milestone row with targets needs a date");
      continue;
    }
    milestones.push({ date, targets });
  }
  if (!milestones.length) return null;
  milestones.sort((a, b) => a.date.localeCompare(b.date));
  return validatePlan({ milestones });
}

/** Target for a metric at a moment, or null when the plan has none for it. */
export function targetAt(plan: Plan, key: string, time: number): number | null {
  const points = plan.milestones
    .filter((m) => key in m.targets)
    .map((m) => ({ time: dateTime(m.date)!, value: m.targets[key] }));
  if (points.length < 2) return null;
  if (time <= points[0].time) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (time <= b.time) return a.value + ((b.value - a.value) * (time - a.time)) / (b.time - a.time);
  }
  return points[points.length - 1].value;
}

/** The target line as chart points: the window ends plus every milestone inside. */
export function targetLine(plan: Plan, key: string, from: number, to: number) {
  const times = [
    from,
    ...plan.milestones
      .filter((m) => key in m.targets)
      .map((m) => dateTime(m.date)!)
      .filter((t) => t > from && t < to),
    to,
  ];
  return times.flatMap((time) => {
    const value = targetAt(plan, key, time);
    return value === null ? [] : [{ time, value }];
  });
}

export function dayKey(time: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time * 1000));
}

/** One point per local day: that day's first reading (the morning weigh-in
 * when the routine is followed), so repeat weigh-ins do not weigh more. */
export function dailyValues(points: Point[], timeZone?: string): Point[] {
  const byDay = new Map<string, Point>();
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    const day = dayKey(p.time, timeZone);
    if (!byDay.has(day)) byDay.set(day, p);
  }
  return [...byDay.values()];
}

/** Mean of the daily values in the `window` days ending at `time`. */
export function rollingAverage(daily: Point[], time: number, window: number) {
  const inside = daily.filter((p) => p.time <= time && p.time > time - window * DAY);
  if (!inside.length) return null;
  return { value: inside.reduce((s, p) => s + p.value, 0) / inside.length, days: inside.length };
}

/** The rolling average at every day with a reading: the trend line. */
export function trendLine(daily: Point[], window: number) {
  return daily.map((p) => ({ time: p.time, value: rollingAverage(daily, p.time, window)!.value }));
}

export type Status = { label: string; tone: "good" | "warn" | "bad" };
export function status(metric: GoalMetric, average: number, target: number): Status {
  const off = metric.better === "lower" ? average - target : target - average;
  if (off <= 0) return { label: "On Track", tone: "good" };
  if (off <= metric.tolerance) return { label: "Close", tone: "warn" };
  return { label: "Behind", tone: "bad" };
}

export type Advice = { tone: "good" | "warn" | "bad"; text: string };

/** The course-correction rules of a fat-loss plan, from the daily values.
 * Only applies when the plan's last weight target is below its first. */
export function courseCheck(plan: Plan, data: Record<string, Point[]>, now: number): Advice[] {
  const weights = plan.milestones.filter((m) => "weight_kg" in m.targets);
  if (weights.length < 2 || weights.at(-1)!.targets.weight_kg >= weights[0].targets.weight_kg)
    return [];
  const advice: Advice[] = [];
  const started = dateTime(plan.milestones[0].date)!;
  const daily = data.weight_kg ?? [];
  if (now < started)
    return [{ tone: "good", text: "The plan has not started yet." }];
  if (now - started < 14 * DAY)
    advice.push({
      tone: "good",
      text: "First two weeks: the early drop is mostly water and stored carbohydrate, so the weekly rate is not judged yet. Weigh in every morning to build your baseline.",
    });
  else {
    const current = rollingAverage(daily, now, 7);
    const before = rollingAverage(daily, now - 21 * DAY, 7);
    if (!current || !before || current.days < 3 || before.days < 3)
      advice.push({
        tone: "warn",
        text: "Not enough morning weigh-ins to judge the last three weeks. Aim for at least 3 a week.",
      });
    else {
      const rate = (before.value - current.value) / 3;
      const shown = `${Math.abs(rate).toFixed(2)} kg a week`;
      const stepTarget = targetAt(plan, "steps", now);
      const stepAverage = rollingAverage(data.steps ?? [], now, 7);
      if (rate < 0.25 && stepTarget !== null && stepAverage && stepAverage.value < stepTarget)
        advice.push({
          tone: "bad",
          text: `${rate < 0 ? "Gaining" : "Losing"} ${shown} over the last three weeks, under 0.25, and steps average ${Math.round(stepAverage.value)} against a target of ${Math.round(stepTarget)}. Get the steps up first, before eating less.`,
        });
      else if (rate < 0.25)
        advice.push({
          tone: "bad",
          text: `${rate < 0 ? "Gaining" : "Losing"} ${shown} over the last three weeks, under 0.25. Eat about 150 kcal less a day, or add about 2,000 steps a day.`,
        });
      else if (rate > 1)
        advice.push({
          tone: "warn",
          text: `Losing ${shown}, over 1 kg a week. Eat a little more: losing this fast costs muscle.`,
        });
      else advice.push({ tone: "good", text: `Losing ${shown} over the last three weeks. Keep going.` });
    }
  }
  const muscle = data.muscle_mass_kg ?? [];
  const now28 = rollingAverage(muscle, now, 28);
  const then28 = rollingAverage(muscle, now - 28 * DAY, 28);
  if (now28 && then28 && now28.days >= 4 && then28.days >= 4 && then28.value - now28.value > 1)
    advice.push({
      tone: "bad",
      text: `Muscle mass is down ${(then28.value - now28.value).toFixed(1)} kg on the 4-week average. Check protein (about 1.6–2 g per kg of goal weight) and strength training before cutting further.`,
    });
  return advice;
}

/** The first milestone dated after `now`, or null when the plan is complete. */
export function nextMilestone(plan: Plan, now: number): Milestone | null {
  return plan.milestones.find((m) => dateTime(m.date)! > now) ?? null;
}
