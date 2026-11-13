/** Server-rendered SVG line charts for the health overview (no script needed).
 * Each marker carries a <title> (native hover) and data-tip (app.js tooltip).
 */
import { escapeHtml as e } from "./ui.ts";

export type ChartPoint = { time: number; value: number; tip: string };
export type ChartOptions = {
  title: string;
  points: ChartPoint[];
  from: number;
  to: number;
  format: (value: number) => string;
  band?: { low: number; high: number } | null;
  /** Extra unmarked lines (trend, target), drawn under the readings. */
  lines?: Array<{ className: string; points: Array<{ time: number; value: number }> }>;
};

const W = 640,
  H = 220,
  LEFT = 56,
  RIGHT = 14,
  TOP = 14,
  BOTTOM = 30;
const r1 = (v: number) => Math.round(v * 10) / 10;
const dateLabel = (time: number) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(time * 1000));

export function lineChart(options: ChartOptions): string {
  const { title, from, to, format, band } = options;
  const points = options.points
    .filter((p) => p.time >= from && p.time <= to && Number.isFinite(p.value))
    .sort((a, b) => a.time - b.time);
  const caption = `<figcaption>${e(title)}</figcaption>`;
  if (!points.length)
    return `<figure class="chart">${caption}<p class="empty">No readings in this period.</p></figure>`;

  // Vertical domain: the data plus the healthy band, padded so nothing touches
  // the edges; a flat series gets a small fixed span instead of dividing by 0.
  const lines = (options.lines ?? []).map((l) => ({
    ...l,
    points: l.points
      .filter((p) => p.time >= from && p.time <= to && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time),
  }));
  const values = points.map((p) => p.value);
  const lineValues = lines.flatMap((l) => l.points.map((p) => p.value));
  const edges = band ? [band.low, band.high] : [];
  let lo = Math.min(...values, ...lineValues, ...edges),
    hi = Math.max(...values, ...lineValues, ...edges);
  if (hi - lo < 1e-9) {
    const pad = Math.max(1, Math.abs(hi) * 0.02);
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  lo -= span * 0.1;
  hi += span * 0.1;
  const plotW = W - LEFT - RIGHT,
    plotH = H - TOP - BOTTOM;
  const y = (v: number) => r1(TOP + ((hi - v) / (hi - lo)) * plotH);
  const x = (t: number) =>
    r1(to > from ? LEFT + ((t - from) / (to - from)) * plotW : LEFT + plotW / 2);

  // Axis labels: lowest and highest reading, and the band edges. Labels closer
  // than 12px to one already placed are dropped rather than overlapping.
  const labelled: Array<{ value: number; at: number }> = [];
  for (const value of [Math.max(...values), Math.min(...values), ...edges]) {
    const at = y(value);
    if (labelled.every((l) => Math.abs(l.at - at) >= 12))
      labelled.push({ value, at });
  }
  const grid = labelled
    .map(
      ({ value, at }) =>
        `<line class="grid" x1="${LEFT}" y1="${at}" x2="${W - RIGHT}" y2="${at}"/><text class="axis" x="${LEFT - 6}" y="${r1(at + 4)}" text-anchor="end">${e(format(value))}</text>`,
    )
    .join("");
  const shaded = band
    ? `<rect class="band" x="${LEFT}" y="${y(band.high)}" width="${plotW}" height="${r1(y(band.low) - y(band.high))}"><title>Healthy range ${e(format(band.low))}–${e(format(band.high))}</title></rect><text class="band-label" x="${W - RIGHT - 4}" y="${r1(y(band.high) + 12)}" text-anchor="end">Healthy range</text>`
    : "";
  const extra = lines
    .filter((l) => l.points.length > 1)
    .map(
      (l) =>
        `<polyline class="${e(l.className)}" points="${l.points.map((p) => `${x(p.time)},${y(p.value)}`).join(" ")}"/>`,
    )
    .join("");
  const line = `<polyline class="line" points="${points.map((p) => `${x(p.time)},${y(p.value)}`).join(" ")}"/>`;
  const dots = points
    .map(
      (p) =>
        `<circle class="dot" cx="${x(p.time)}" cy="${y(p.value)}" r="4" data-tip="${e(p.tip)}"><title>${e(p.tip)}</title></circle>`,
    )
    .join("");
  const dates = `<text class="axis" x="${LEFT}" y="${H - 8}">${e(dateLabel(from))}</text><text class="axis" x="${W - RIGHT}" y="${H - 8}" text-anchor="end">${e(dateLabel(to))}</text>`;
  return `<figure class="chart">${caption}<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(title)} chart, ${points.length} readings">${shaded}${grid}${dates}${extra}${line}${dots}</svg></figure>`;
}
