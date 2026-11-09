/** Health overview page: one user's latest values, ratings and charts. */
import { escapeHtml as e, timeLabel, weightLabel } from "./ui.ts";
import { lineChart } from "./chart.ts";
import {
  OVERVIEW,
  REFERENCE_NOTES,
  healthyBand,
  latest,
  rate,
  series,
  type OverviewMetric,
  type Profile,
} from "./health.ts";

type Row = Record<string, any>;
export const RANGES = [
  ["1m", "1 Month", 30],
  ["3m", "3 Months", 91],
  ["1y", "1 Year", 365],
  ["all", "All", null],
] as const;
export type RangeKey = (typeof RANGES)[number][0];
const LB_PER_KG = 2.2046226218487757;

export function profileOf(user: Row): Profile {
  return {
    sex: Number(user.sex),
    heightCm: user.height_cm == null ? null : Number(user.height_cm),
    birthDate: user.birth_date ?? null,
    ageYears: user.age_years == null ? null : Number(user.age_years),
  };
}

/** Number in display units: masses in kg, or lb for lb and st displays. */
function displayNumber(metric: OverviewMetric, value: number, unit: string) {
  return metric.kind === "mass" && unit !== "kg" ? value * LB_PER_KG : value;
}
function unitSuffix(metric: OverviewMetric, unit: string) {
  if (metric.kind === "mass") return unit === "kg" ? " kg" : " lb";
  if (metric.kind === "percent") return " %";
  return metric.unit ? ` ${metric.unit}` : "";
}
function valueText(metric: OverviewMetric, value: number, unit: string) {
  if (metric.kind === "mass" && unit === "st")
    return weightLabel({ weight_value: Math.round(value * 1000), weight_unit: -3 }, "st");
  return `${displayNumber(metric, value, unit).toFixed(metric.decimals)}${unitSuffix(metric, unit)}`;
}
function deltaText(metric: OverviewMetric, now: number, before: number, unit: string) {
  const change = displayNumber(metric, now, unit) - displayNumber(metric, before, unit);
  const shown = Math.abs(change).toFixed(metric.decimals);
  const zero = Number(shown) === 0;
  const arrow = zero ? "=" : change > 0 ? "▲" : "▼";
  const words = zero ? "no change" : `${change > 0 ? "up" : "down"} ${shown}${unitSuffix(metric, unit)}`;
  return `<span class="delta" title="Since the previous reading" aria-label="${e(words)} since the previous reading">${arrow} ${e(shown)}${e(unitSuffix(metric, unit))}</span>`;
}
const query = (user: number, range: string, shown: string[]) =>
  `/?${new URLSearchParams([
    ["user", String(user)],
    ["range", range],
    ...shown.map((key) => ["show", key]),
  ])}`;

export function overviewPage(options: {
  users: Row[];
  user: Row | null;
  rows: Row[];
  range: RangeKey;
  shown: string[];
  unit: string;
  now: number;
}): string {
  const { users, user, rows, range, unit, now } = options;
  const heading = `<section class="page-heading"><div><h1>Dashboard</h1></div><a class="button secondary" href="/readings">View All Readings</a></section>`;
  if (!user)
    return `${heading}<section><p class="empty">No users have been added yet.</p><a class="button" href="/firmware">Add Your First Scale</a></section>`;

  const profile = profileOf(user);
  const data = series(rows, profile);
  const measured = OVERVIEW.filter((m) => data[m.key]?.length);
  const shown = options.shown.filter(
    (key) => key !== "weight_kg" && measured.some((m) => m.key === key),
  );
  const userId = Number(user.id);
  const tabs = `<nav class="user-tabs" aria-label="Users">${users
    .map(
      (u) =>
        `<a href="${e(query(Number(u.id), range, shown))}"${Number(u.id) === userId ? ' aria-current="page"' : ""}>${e(u.name)}</a>`,
    )
    .join("")}</nav>`;
  if (!measured.length)
    return `${heading}${tabs}<section><p class="empty">No readings recorded yet.</p></section>`;

  const tiles = measured
    .map((metric) => {
      const { latest: point, previous } = latest(data[metric.key])!;
      const rating = rate(metric.key, point.value, profile, point.time);
      return `<article class="tile" data-metric="${e(metric.key)}"><h3>${e(metric.label)}</h3><p class="tile-value">${e(valueText(metric, point.value, unit))}</p><p class="tile-meta">${previous ? deltaText(metric, point.value, previous.value, unit) : ""}${rating ? `<span class="badge${rating.tone === "good" ? "" : ` ${rating.tone}`}">${e(rating.label)}</span>` : ""}</p><p class="hint">${timeLabel(point.time)}</p></article>`;
    })
    .join("");

  const days = RANGES.find(([key]) => key === range)![2];
  const earliest = Math.min(...measured.map((m) => data[m.key][0].time));
  const from = days === null ? Math.min(earliest, now) : now - days * 86400;
  const rangeLinks = `<nav class="range-links" aria-label="Chart period">${RANGES.map(
    ([key, label]) =>
      `<a class="button secondary" href="${e(query(userId, key, shown))}"${key === range ? ' aria-current="page"' : ""}>${e(label)}</a>`,
  ).join("")}</nav>`;
  const toggles = measured.length > 1
    ? `<form method="get" class="chart-toggles"><input type="hidden" name="user" value="${e(userId)}"><input type="hidden" name="range" value="${e(range)}"><fieldset><legend>Also Chart</legend>${measured
        .filter((m) => m.key !== "weight_kg")
        .map(
          (m) =>
            `<label><input type="checkbox" name="show" value="${e(m.key)}"${shown.includes(m.key) ? " checked" : ""} data-submit-on-change> ${e(m.label)}</label>`,
        )
        .join("")}</fieldset><button class="secondary" type="submit">Update Charts</button></form>`
    : "";
  const chartKeys = ["weight_kg", ...shown].filter((key) => data[key]?.length);
  const charts = OVERVIEW.filter((m) => chartKeys.includes(m.key))
    .map((metric) =>
      lineChart({
        title: metric.label,
        from,
        to: now,
        format: (v) => displayNumber(metric, v, unit).toFixed(metric.decimals),
        // Banded metrics are percentages or BMI, never unit-converted masses.
        band: healthyBand(metric.key, profile, now),
        points: data[metric.key].map((p) => ({
          time: p.time,
          value: displayNumber(metric, p.value, unit),
          tip: `${timeLabel(p.time)} · ${valueText(metric, p.value, unit)}`,
        })),
      }),
    )
    .join("");
  const notes = `<details class="references"><summary>About these ranges</summary><p>Ratings compare your values with general population reference ranges. They are for information only and are not medical advice.</p><ul>${REFERENCE_NOTES.map((n) => `<li>${e(n)}</li>`).join("")}</ul></details>`;
  return `${heading}${tabs}<section><div class="tiles">${tiles}</div>${notes}</section><section><div class="section-heading"><h2>Trends</h2>${rangeLinks}</div>${toggles}<div class="charts">${charts}</div></section>`;
}
