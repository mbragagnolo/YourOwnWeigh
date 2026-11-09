import test from "node:test";
import assert from "node:assert/strict";
import { lineChart } from "../chart.ts";

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 1) / 1000;
const fmt = (v: number) => v.toFixed(1);
const points = [
  { time: T0 + DAY, value: 82.8, tip: "2 Oct · 82.8 kg" },
  { time: T0 + 10 * DAY, value: 81.6, tip: "11 Oct · 81.6 kg" },
  { time: T0 + 20 * DAY, value: 81.7, tip: "21 Oct · 81.7 kg" },
];
const circles = (svg: string) => [...svg.matchAll(/<circle\b[^>]*>/g)];
const numbers = (svg: string) =>
  [...svg.matchAll(/\b(?:cx|cy|x|y|width|height|points)="([^"]*)"/g)].flatMap(
    (m) => m[1].split(/[ ,]+/).filter(Boolean).map(Number),
  );

test("a chart has one marker per reading with a hover label and a line", () => {
  const svg = lineChart({ title: "Weight", points, from: T0, to: T0 + 30 * DAY, format: fmt });
  assert.match(svg, /<svg\b[^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /role="img"/);
  assert.equal(circles(svg).length, 3);
  assert.match(svg, /<title>11 Oct · 81\.6 kg<\/title>/);
  assert.match(svg, /data-tip="2 Oct · 82\.8 kg"/);
  const line = /<polyline\b[^>]*points="([^"]+)"/.exec(svg);
  assert.ok(line);
  assert.equal(line[1].trim().split(/\s+/).length, 3);
  assert.match(svg, />82\.8</); // Axis labels use the formatter.
  assert.ok(numbers(svg).every(Number.isFinite));
});

test("markers run left to right in time and higher values sit higher", () => {
  const svg = lineChart({ title: "Weight", points, from: T0, to: T0 + 30 * DAY, format: fmt });
  const xy = circles(svg).map((c) => [
    Number(/cx="([^"]+)"/.exec(c[0])![1]),
    Number(/cy="([^"]+)"/.exec(c[0])![1]),
  ]);
  assert.ok(xy[0][0] < xy[1][0] && xy[1][0] < xy[2][0]);
  assert.ok(xy[0][1] < xy[1][1]); // 82.8 is drawn above 81.6 (SVG y grows down).
});

test("an empty period shows a message instead of a chart", () => {
  const html = lineChart({ title: "Heart Rate", points: [], from: T0, to: T0 + DAY, format: fmt });
  assert.match(html, /No readings in this period/);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /Heart Rate/);
});

test("points outside the period are left out", () => {
  const svg = lineChart({ title: "Weight", points, from: T0 + 5 * DAY, to: T0 + 30 * DAY, format: fmt });
  assert.equal(circles(svg).length, 2);
  assert.doesNotMatch(svg, /2 Oct/);
});

test("a single reading or a flat series still draws finite coordinates", () => {
  const one = lineChart({ title: "Weight", points: [points[0]], from: T0, to: T0 + 30 * DAY, format: fmt });
  assert.equal(circles(one).length, 1);
  assert.ok(numbers(one).every(Number.isFinite));
  const flat = lineChart({
    title: "Weight",
    points: points.map((p) => ({ ...p, value: 100 })),
    from: T0,
    to: T0 + 30 * DAY,
    format: fmt,
  });
  assert.ok(numbers(flat).every(Number.isFinite));
  const sameTime = lineChart({
    title: "Weight",
    points: [points[0], { ...points[1], time: points[0].time }],
    from: points[0].time,
    to: points[0].time,
    format: fmt,
  });
  assert.ok(numbers(sameTime).every(Number.isFinite));
});

test("a healthy band is shaded inside the plot and only when given", () => {
  const pct = [
    { time: T0 + DAY, value: 31.5, tip: "a" },
    { time: T0 + 2 * DAY, value: 31.2, tip: "b" },
  ];
  const withBand = lineChart({
    title: "Body Fat",
    points: pct,
    from: T0,
    to: T0 + 3 * DAY,
    format: fmt,
    band: { low: 11, high: 22 },
  });
  const rect = /<rect class="band"[^>]*y="([^"]+)"[^>]*height="([^"]+)"/.exec(withBand);
  assert.ok(rect, "band drawn");
  const view = /viewBox="0 0 (\d+) (\d+)"/.exec(withBand)!;
  assert.ok(Number(rect[1]) >= 0 && Number(rect[1]) + Number(rect[2]) <= Number(view[2]));
  assert.match(withBand, /Healthy range/);
  assert.match(withBand, />22\.0</); // The band edges are part of the scale.
  const without = lineChart({ title: "Body Fat", points: pct, from: T0, to: T0 + 3 * DAY, format: fmt });
  assert.doesNotMatch(without, /class="band"/);
});

test("text is escaped", () => {
  const svg = lineChart({
    title: "<b>W</b>",
    points: [{ time: T0 + DAY, value: 1, tip: '"><script>' }],
    from: T0,
    to: T0 + 2 * DAY,
    format: fmt,
  });
  assert.doesNotMatch(svg, /<script>|<b>W/);
  assert.match(svg, /&lt;b&gt;W&lt;\/b&gt;/);
});
