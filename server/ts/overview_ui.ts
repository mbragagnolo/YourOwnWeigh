/** Health overview: weight header, composition bar and one row per measurement,
 * plus a page per measurement with its verdict, range bar and chart. */
import { escapeHtml as e, timeLabel, weightLabel } from "./ui.ts";
import { lineChart } from "./chart.ts";
import {
  OVERVIEW,
  REFERENCE_NOTES,
  compositionOf,
  healthyBand,
  latest,
  markerPosition,
  rate,
  scaleFor,
  series,
  verdict,
  type OverviewMetric,
  type Point,
  type Profile,
  type Scale,
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
function delta(change: number, decimals: number, suffix: string, since: string) {
  const shown = Math.abs(change).toFixed(decimals);
  const zero = Number(shown) === 0;
  const arrow = zero ? "=" : change > 0 ? "▲" : "▼";
  const words = zero ? "no change" : `${change > 0 ? "up" : "down"} ${shown}${suffix}`;
  return `<span class="delta" aria-label="${e(words)} ${e(since)}">${arrow} ${e(shown)}${e(suffix)}</span> <span class="since">${e(since)}</span>`;
}
const query = (user: number, range: string, metric?: string) =>
  `/?${new URLSearchParams([
    ["user", String(user)],
    ["range", range],
    ...(metric ? [["metric", metric]] : []),
  ])}`;

const toneClass = (tone: string) => (tone === "good" ? "good" : tone);
const pct = (x: number) => `${(x * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
function edgeText(edge: number) {
  return Number.isInteger(edge) ? String(edge) : edge.toFixed(1);
}

/** Equal-width band segments with a marker; labelled adds edges and names. */
function rangeBar(scale: Scale, value: number, labelled: boolean) {
  const n = scale.bands.length;
  const segments = scale.bands
    .map((b) => `<span class="seg ${toneClass(b.tone)}"></span>`)
    .join("");
  const markerAt = pct(markerPosition(scale, value));
  if (!labelled)
    return `<span class="range-bar" aria-hidden="true">${segments}<span class="marker" style="left:${markerAt}"></span></span>`;
  const edges = scale.edges
    .map((edge, i) => `<span class="edge" style="left:${pct((i + 1) / n)}">${e(edgeText(edge))}</span>`)
    .join("");
  const names = scale.bands
    .map((b) => `<span class="band-name">${e(b.label)}</span>`)
    .join("");
  return `<div class="range-bar labelled" aria-hidden="true"><div class="edges">${edges}</div><div class="segs">${segments}<span class="marker" style="left:${markerAt}"></span></div><div class="band-names">${names}</div></div>`;
}

export function overviewPage(options: {
  users: Row[];
  user: Row | null;
  rows: Row[];
  range: RangeKey;
  metric: string | null;
  unit: string;
  now: number;
}): string {
  const { users, user, rows, range, unit, now } = options;
  const heading = (title: string, back = "") =>
    `<section class="page-heading"><div>${back}<h1>${e(title)}</h1></div><a class="button secondary" href="/readings">View All Readings</a></section>`;
  if (!user)
    return `${heading("Dashboard")}<section><p class="empty">No users have been added yet.</p><a class="button" href="/firmware">Add Your First Scale</a></section>`;

  const profile = profileOf(user);
  const data = series(rows, profile);
  const measured = OVERVIEW.filter((m) => data[m.key]?.length);
  const userId = Number(user.id);
  const metric = measured.find((m) => m.key === options.metric) ?? null;
  const tabs = `<nav class="user-tabs" aria-label="Users">${users
    .map(
      (u) =>
        `<a href="${e(query(Number(u.id), range, metric?.key))}"${Number(u.id) === userId ? ' aria-current="page"' : ""}>${e(u.name)}</a>`,
    )
    .join("")}</nav>`;
  if (!measured.length)
    return `${heading("Dashboard")}${tabs}<section><p class="empty">No readings recorded yet.</p></section>`;

  const days = RANGES.find(([key]) => key === range)![2];
  const earliest = Math.min(...measured.map((m) => data[m.key][0].time));
  const from = days === null ? Math.min(earliest, now) : now - days * 86400;
  const rangeLinks = `<nav class="range-links" aria-label="Chart period">${RANGES.map(
    ([key, label]) =>
      `<a class="button secondary" href="${e(query(userId, key, metric?.key))}"${key === range ? ' aria-current="page"' : ""}>${e(label)}</a>`,
  ).join("")}</nav>`;
  const chart = (m: OverviewMetric) =>
    lineChart({
      title: m.label,
      from,
      to: now,
      format: (v) => displayNumber(m, v, unit).toFixed(m.decimals),
      // Banded metrics are percentages or BMI, never unit-converted masses.
      band: healthyBand(m.key, profile, now),
      points: data[m.key].map((p: Point) => ({
        time: p.time,
        value: displayNumber(m, p.value, unit),
        tip: `${timeLabel(p.time)} · ${valueText(m, p.value, unit)}`,
      })),
    });
  const notes = `<details class="references"><summary>About these ranges</summary><p>Ratings compare your values with general population reference ranges. They are for information only and are not medical advice.</p><ul>${REFERENCE_NOTES.map((n) => `<li>${e(n)}</li>`).join("")}</ul></details>`;

  if (metric) {
    const { latest: point, previous } = latest(data[metric.key])!;
    const scale = scaleFor(metric.key, profile, point.time);
    const rating = rate(metric.key, point.value, profile, point.time);
    const change = previous
      ? delta(
          displayNumber(metric, point.value, unit) - displayNumber(metric, previous.value, unit),
          metric.decimals,
          unitSuffix(metric, unit),
          "since the previous reading",
        )
      : "";
    const back = `<a class="back" href="${e(query(userId, range))}">← Overview</a>`;
    const summary = `${rating ? `<p class="verdict">${e(verdict(metric.key, metric.label, rating))}</p>` : ""}${scale ? `<p class="hint">${e(scale.basis)}</p>` : ""}<p class="hero-value">${e(valueText(metric, point.value, unit))}</p><p class="hero-meta">${change}</p><p class="hint">${timeLabel(point.time)}</p>${scale ? rangeBar(scale, point.value, true) : ""}`;
    return `${heading(metric.label, back)}${tabs}<section class="measure-page">${summary}</section><section><div class="section-heading"><h2>Over Time</h2>${rangeLinks}</div>${chart(metric)}${scale ? notes : ""}</section>`;
  }

  const weightMetric = OVERVIEW[0];
  const weight = latest(data.weight_kg);
  const hero = weight
    ? `<section class="weight-hero"><p class="hint">Weight · ${timeLabel(weight.latest.time)}</p><p class="hero-value">${e(valueText(weightMetric, weight.latest.value, unit))}</p><p class="hero-meta">${
        weight.previous
          ? delta(
              ((weight.latest.value - weight.previous.value) / weight.previous.value) * 100,
              1,
              " %",
              "since the previous weigh-in",
            )
          : ""
      }</p>${rangeLinks}${chart(weightMetric)}</section>`
    : "";

  const share = compositionOf(rows, profile);
  const composition = share
    ? `<section class="composition-card"><h2>Body Composition</h2><div class="composition" role="img" aria-label="Muscle ${share.muscle.toFixed(1)} %, fat ${share.fat.toFixed(1)} %, bone ${share.bone.toFixed(1)} % of weight">${(
        [["muscle", share.muscle], ["fat", share.fat], ["bone", share.bone]] as const
      )
        .map(([name, value]) => `<span class="comp ${name}" style="width:${value.toFixed(2)}%"></span>`)
        .join("")}</div><p class="composition-legend"><span class="key muscle">Muscle ${share.muscle.toFixed(1)} %</span><span class="key fat">Fat ${share.fat.toFixed(1)} %</span><span class="key bone">Bone ${share.bone.toFixed(1)} %</span></p></section>`
    : "";

  const measures = measured
    .filter((m) => m.key !== "weight_kg")
    .map((m) => {
      const { latest: point } = latest(data[m.key])!;
      const scale = scaleFor(m.key, profile, point.time);
      const rating = rate(m.key, point.value, profile, point.time);
      return `<a class="measure" data-metric="${e(m.key)}" href="${e(query(userId, range, m.key))}"><span class="measure-name">${e(m.label)}${rating ? `<span class="rating ${toneClass(rating.tone)}">${e(rating.label)}</span>` : ""}</span><span class="measure-value">${e(valueText(m, point.value, unit))}</span>${scale ? rangeBar(scale, point.value, false) : '<span class="no-bar"></span>'}<span class="chevron" aria-hidden="true">›</span></a>`;
    })
    .join("");
  const list = measures
    ? `<section><h2>All Body Measurements</h2><div class="measures">${measures}</div>${notes}</section>`
    : "";
  return `${heading("Dashboard")}${tabs}${hero}${composition}${list}`;
}
