/** Goals page: a user's milestone plan, today's smoothed values against the
 * plan's line, course-correction advice, charts and the plan editor. */
import { escapeHtml as e, hidden, timeLabel } from "./ui.ts";
import { lineChart } from "./chart.ts";
import { series, type Point } from "./health.ts";
import { profileOf } from "./overview_ui.ts";
import {
  GOAL_METRICS,
  MAX_MILESTONES,
  courseCheck,
  dailyValues,
  dateTime,
  nextMilestone,
  rollingAverage,
  status,
  targetAt,
  targetLine,
  trendLine,
  type GoalMetric,
  type Plan,
} from "./goals.ts";

type Row = Record<string, any>;
const DAY = 86400;
const LB_PER_KG = 2.2046226218487757;
export const GOAL_RANGES = [
  ["1m", "1 Month", 30],
  ["3m", "3 Months", 91],
  ["plan", "Whole Plan", null],
] as const;
export type GoalRangeKey = (typeof GOAL_RANGES)[number][0];

const query = (user: number, range: string) =>
  `/goals?${new URLSearchParams([
    ["user", String(user)],
    ["range", range],
  ])}`;
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(dateTime(date)! * 1000),
  );

function display(metric: GoalMetric, value: number, unit: string) {
  return metric.mass && unit !== "kg" ? value * LB_PER_KG : value;
}
function valueText(metric: GoalMetric, value: number, unit: string) {
  const suffix = metric.mass && unit !== "kg" ? " lb" : metric.suffix;
  return `${display(metric, value, unit).toFixed(metric.decimals)}${suffix}`;
}

function editor(plan: Plan | null, userId: number, csrf: string) {
  const rows = [...(plan?.milestones ?? [])];
  const count = Math.min(MAX_MILESTONES, Math.max(6, rows.length + 2));
  const head = `<tr><th>Date</th>${GOAL_METRICS.map((m) => `<th>${e(m.column)}</th>`).join("")}</tr>`;
  const body = Array.from({ length: count }, (_, i) => {
    const m = rows[i];
    return `<tr><td><input type="date" name="date_${i}" value="${e(m?.date ?? "")}" aria-label="Milestone ${i + 1} date"></td>${GOAL_METRICS.map(
      (g) =>
        `<td><input type="number" step="${g.decimals ? "0.1" : "1"}" min="${g.min}" max="${g.max}" name="${e(g.key)}_${i}" value="${m && g.key in m.targets ? e(m.targets[g.key]) : ""}" aria-label="Milestone ${i + 1} ${e(g.label)}"></td>`,
    ).join("")}</tr>`;
  }).join("");
  return `<form class="goal-editor" action="/goals" method="post">${hidden(csrf)}<input type="hidden" name="user" value="${userId}"><p class="hint">The first row is where you start, the last where you want to be. Masses are in kg. Leave a cell empty to skip that measure; give a measure at least two dates or none. Clear every date to remove the plan.</p><div class="wide"><table>${head}${body}</table></div><div class="dialog-actions"><button>Save Plan</button></div></form>`;
}

export type WatchInfo = {
  linked: Row[];
  unlinked: Row[];
  series: Record<string, Point[]>;
};
const productName = (product: string) =>
  product === "vivoactive4Large" || product === "vivoactive4Small"
    ? "vívoactive 4"
    : product.replace(/([a-z])([A-Z0-9])/g, "$1 $2");

/** Linked watches with their last import, and a link form for new ones. */
function watchSection(watch: WatchInfo, userId: number, csrf: string, users: Row[]) {
  if (!watch.linked.length && !watch.unlinked.length) return "";
  const owner = (id: unknown) => users.find((u) => Number(u.id) === Number(id))?.name;
  const linked = watch.linked
    .map(
      (d) =>
        `<li><strong>${e(productName(d.product))}</strong> · last import ${timeLabel(d.last_import_at)}<form class="inline" action="/goals/watch" method="post">${hidden(csrf)}<input type="hidden" name="serial" value="${e(d.serial)}"><input type="hidden" name="user" value="${userId}"><input type="hidden" name="link" value="0"><button class="secondary">Unlink</button></form></li>`,
    )
    .join("");
  const unlinked = watch.unlinked
    .map(
      (d) =>
        `<li><strong>${e(productName(d.product))}</strong>${d.user_id ? ` · linked to ${e(owner(d.user_id) ?? "another user")}` : " · not linked yet"}<form class="inline" action="/goals/watch" method="post">${hidden(csrf)}<input type="hidden" name="serial" value="${e(d.serial)}"><input type="hidden" name="user" value="${userId}"><input type="hidden" name="link" value="1"><button>Link To ${e(owner(userId) ?? "This User")}</button></form></li>`,
    )
    .join("");
  return `<section class="goal-card"><h2>Watch</h2><ul class="watch-list">${linked}${unlinked}</ul><p class="hint">Resting heart rate, steps and VO2 max come from the watch. Plug it into this PC to sync; the scheduled task copies new files within a few minutes.</p></section>`;
}

const PROTOCOL = `<details class="references"><summary>How to weigh in</summary><ul><li>Every morning, after the toilet and before eating or drinking.</li><li>No clothes, dry bare feet, the scale in the same place on a hard floor.</li><li>Never straight after training: impedance readings swing by kilograms.</li><li>Only the first reading of each day counts here, so repeat weigh-ins do not skew the average.</li><li>Weight is judged on its 7-day average, body composition on its 4-week average.</li></ul></details>`;

export function goalsPage(options: {
  users: Row[];
  user: Row | null;
  rows: Row[];
  plan: Plan | null;
  range: GoalRangeKey;
  unit: string;
  now: number;
  csrf: string;
  timeZone?: string;
  watch?: WatchInfo;
}): string {
  const { users, user, rows, plan, range, unit, now, csrf, timeZone } = options;
  const watch = options.watch ?? { linked: [], unlinked: [], series: {} };
  const heading = `<section class="page-heading"><div><h1>Goals</h1></div></section>`;
  if (!user) return `${heading}<section><p class="empty">No users have been added yet.</p></section>`;
  const userId = Number(user.id);
  const tabs = `<nav class="user-tabs" aria-label="Users">${users
    .map(
      (u) =>
        `<a href="${e(query(Number(u.id), range))}"${Number(u.id) === userId ? ' aria-current="page"' : ""}>${e(u.name)}</a>`,
    )
    .join("")}</nav>`;
  const watchCard = watchSection(watch, userId, csrf, users);
  if (!plan)
    return `${heading}${tabs}${watchCard}<section class="goal-card"><h2>No Plan Yet</h2><p>Set dated milestones for the measures you want to change. Each day, the page compares your smoothed readings with the straight line between milestones, so a single heavy morning never reads as failure.</p>${editor(null, userId, csrf)}</section>${PROTOCOL}`;

  const raw = series(rows, profileOf(user));
  const daily: Record<string, Point[]> = {
    ...Object.fromEntries(
      Object.entries(raw).map(([key, points]) => [key, dailyValues(points, timeZone)]),
    ),
    // Watch series already hold one value per watch-local day.
    ...watch.series,
  };
  const metrics = GOAL_METRICS.filter((m) => targetAt(plan, m.key, now) !== null);
  const start = dateTime(plan.milestones[0].date)!;
  const end = dateTime(plan.milestones.at(-1)!.date)!;
  const next = nextMilestone(plan, now);

  const tiles = metrics
    .map((m) => {
      const target = targetAt(plan, m.key, now)!;
      const final = targetAt(plan, m.key, end)!;
      const average = rollingAverage(daily[m.key] ?? [], now, m.window);
      const judged = average ? status(m, average.value, target) : null;
      const windowText = m.window === 7 ? "7-day average" : "4-week average";
      return `<div class="goal-tile"><p class="goal-name">${e(m.label)}${judged ? `<span class="rating ${judged.tone}">${e(judged.label)}</span>` : ""}</p><p class="goal-value">${average ? e(valueText(m, average.value, unit)) : "—"}</p><p class="hint">${average ? `${windowText} · ${average.days} day${average.days === 1 ? "" : "s"}` : `No readings in the last ${m.window} days`}</p><p class="goal-target">Target today <strong>${e(valueText(m, target, unit))}</strong><br>Goal <strong>${e(valueText(m, final, unit))}</strong></p></div>`;
    })
    .join("");

  const advice = courseCheck(plan, daily, now);
  const adviceCard = advice.length
    ? `<section class="goal-card"><h2>Course Check</h2><ul class="advice">${advice
        .map((a) => `<li class="${a.tone}">${e(a.text)}</li>`)
        .join("")}</ul></section>`
    : "";

  const table = `<div class="wide"><table class="milestones"><tr><th>Date</th>${metrics.map((m) => `<th>${e(m.column)}</th>`).join("")}</tr>${plan.milestones
    .map((ms) => {
      const time = dateTime(ms.date)!;
      const tag = ms === next ? ' <span class="badge">Next</span>' : time <= now ? ' <span class="hint">passed</span>' : "";
      return `<tr${ms === next ? ' class="next"' : ""}><td>${e(dateLabel(ms.date))}${tag}</td>${metrics
        .map((m) => `<td>${m.key in ms.targets ? e(valueText(m, ms.targets[m.key], unit)) : ""}</td>`)
        .join("")}</tr>`;
    })
    .join("")}</table></div>`;
  const countdown = next
    ? `<p class="hint">Next milestone ${e(dateLabel(next.date))}, in ${Math.max(1, Math.ceil((dateTime(next.date)! - now) / DAY))} days.</p>`
    : `<p class="hint">Every milestone has passed. Hold here, or add new milestones below.</p>`;

  const days = GOAL_RANGES.find(([key]) => key === range)![2];
  // The whole plan also shows readings from before its first milestone.
  const firstReading = Math.min(
    ...metrics.map((m) => daily[m.key]?.[0]?.time ?? Infinity),
  );
  const from =
    days === null ? Math.min(start, now, firstReading) : now - days * DAY;
  const to = days === null ? Math.max(end, now) : now;
  const rangeLinks = `<nav class="range-links" aria-label="Chart period">${GOAL_RANGES.map(
    ([key, label]) =>
      `<a class="button secondary" href="${e(query(userId, key))}"${key === range ? ' aria-current="page"' : ""}>${e(label)}</a>`,
  ).join("")}</nav>`;
  const charts = metrics
    .filter((m) => daily[m.key]?.length)
    .map((m) => {
      const d = (v: number) => display(m, v, unit);
      return lineChart({
        title: `${m.label} · ${m.window === 7 ? "7-day" : "4-week"} average against target`,
        from,
        to,
        format: (v) => v.toFixed(m.decimals),
        points: daily[m.key].map((p) => ({
          time: p.time,
          value: d(p.value),
          tip: `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone }).format(new Date(p.time * 1000))} · ${valueText(m, p.value, unit)}`,
        })),
        lines: [
          { className: "target", points: targetLine(plan, m.key, from, to).map((p) => ({ time: p.time, value: d(p.value) })) },
          { className: "trend", points: trendLine(daily[m.key], m.window).map((p) => ({ time: p.time, value: d(p.value) })) },
        ],
      });
    })
    .join("");
  const legend = `<p class="goal-legend"><span class="key daily">Daily value</span><span class="key trend">Rolling average</span><span class="key target">Target</span></p>`;

  return `${heading}${tabs}<section class="goal-card"><h2>Today</h2><div class="goal-tiles">${tiles}</div></section>${adviceCard}${watchCard}<section class="goal-card"><h2>Milestones</h2>${countdown}${table}</section><section class="goal-charts"><div class="section-heading"><h2>Over Time</h2>${rangeLinks}</div>${legend}${charts || '<p class="empty">No readings yet for the measures in this plan.</p>'}</section>${PROTOCOL}<details class="goal-card"><summary>Edit Plan</summary>${editor(plan, userId, csrf)}</details>`;
}
