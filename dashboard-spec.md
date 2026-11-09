# Spec: Health overview dashboard

> Tracking: none. Personal feature on `windows-local`, not intended upstream (the GitHub remote is the upstream project).

## Summary
Replace the home page's per-user tables with a health overview like the Withings app: for the selected user, the latest value of every measured metric with a quality rating against published reference ranges and the change since the previous reading, followed by time-series charts (weight always, other metrics optional) with the healthy range shaded where one exists. `/readings` stays as the full table.

## Inputs
- **Readings** (`readings` table): `measures_json` (Withings type/value/unit-exponent triples), `meastime`/`time_quality`, `user_id`. Heart rate (type 11) arrives in its own reading row with the same timestamp as the body-composition row.
- **User profile** (`users`): `height_cm`, `birth_date` or `age_years`, `sex` (0 = male, 1 = female, as in the Users form).
- **Display unit**: setting `display_weight_unit` (kg default); mass metrics follow it.
- **Query parameters** on `/`: `user` (user id, default first active user), `range` (`1m` | `3m` | `1y` | `all`, default `3m`), and the set of extra charted metrics (exact parameter shape is an implementation detail; must survive reload and be linkable).

## Outputs
- `GET /` renders, for one user:
  1. **User tabs** (one per active user).
  2. **Metric tiles**, one per metric the user has data for: label, latest value with unit, reading date, change since the previous reading of that metric (arrow + signed delta), and a rating badge (text + colour) where the metric is rated.
  3. **Charts**: weight always; each other metric toggleable. Range buttons 1M / 3M / 1Y / All.
  4. A short note: ranges are general population references for information, not medical advice.
- Charts are server-rendered inline SVG; hovering a point shows date and exact value via a small addition to `server/static/app.js`.
- No change to the database, the scale protocol or the Sync API.

## Behavior
- **Latest value per metric** = the most recent reading *containing that metric type* for the user (not the latest reading overall). Same rule for "previous" when computing the delta.
- **Derived metrics**, computed per reading when the inputs exist in the same reading:
  - Body fat % = fat mass (8) / weight (1) × 100 (or type 6 if the scale sends it).
  - Water % = water mass (77) / weight (1) × 100.
  - BMI = weight / (height_cm/100)² using the user's current height.
- **Ratings** come from one data table in the code, each row with its source. Initial content (verify figures against the cited source while implementing):

  | Metric | Basis | Bands |
  |---|---|---|
  | Body fat % | Gallagher et al. 2000, by sex and age (20–39 / 40–59 / 60–79) | Low · Healthy · High · Very high. Men 20–39: <8 / 8–20 / 20–25 / >25; 40–59: <11 / 11–22 / 22–28 / >28; 60–79: <13 / 13–25 / 25–30 / >30. Women 20–39: <21 / 21–33 / 33–39 / >39; 40–59: <23 / 23–34 / 34–40 / >40; 60–79: <24 / 24–36 / 36–42 / >42 |
  | BMI | WHO | <18.5 Underweight · 18.5–24.9 Healthy · 25–29.9 Overweight · ≥30 Obese |
  | Visceral fat index (170) | Common scale convention | 1–12 Healthy · ≥13 High |
  | Water % | Commonly cited adult ranges | Men 50–65, women 45–60 Healthy; below Low; above High |
  | Heart rate (11) | AHA resting adult | <60 Low · 60–100 Normal · >100 High |
  | Metabolic age (227) | Compared with the user's actual age | ≤ age Good · > age Above your age |
  | Muscle (76), bone (88), fat-free mass (5), fat mass (8), BMR (226) | — | No rating; value and trend only |

- **Age** for banding: from `birth_date` at the reading's date when present, otherwise `age_years`.
- **Charts**: one point per reading in the selected range, x = measurement time, y = value in display units; line plus points. Shaded healthy band behind body fat %, BMI and water % (same table as the ratings, so they always agree). Weight chart always shown; other metrics toggleable.
- **Delta**: latest minus previous value of the same metric, rounded to the metric's display precision; arrow up/down/flat. No good/bad colouring of the delta (direction is not inherently good or bad).

## Edge cases
- User with no readings → tiles area shows the existing "No readings recorded yet" message, no charts.
- No users → keep the current "No users have been added yet" state.
- Only one reading of a metric → no delta; chart shows a single point.
- No readings in the selected range → chart shows "No readings in this period" with the range buttons still usable.
- Weight-only readings (unrecognised, later assigned) → contribute to weight/BMI only.
- Age outside 20–79 → body fat % shown unrated (Gallagher covers 20–79).
- Missing height → BMI not shown.
- Unknown metric types → ignored on this page (still kept in `/readings` and the API).
- Readings with `time_quality` not trusted → plotted at received time, as the tables already do.
- Unknown `user`/`range` query values → fall back to the defaults, never an error page.

## Errors
- Bad query parameters fall back to defaults (no 400 for a dashboard view).
- Malformed stored `measures_json` for a reading → skip that reading for this page rather than failing the page.

## Constraints & dependencies
- TypeScript server-rendered HTML in the existing style (`server/ts/ui.ts` page functions, `app.ts` routes, `metrics.ts` metric table). Reuse `METRICS`, `storedMeasures`, `decimalValue`, unit formatting.
- **No new dependencies.** CSP is `script-src 'self'`: no CDN, no inline script. Inline SVG and inline styles are allowed.
- Charts and tiles readable in the existing light theme, with text labels on ratings (not colour alone).
- Rating thresholds and rating/derivation logic in pure functions with unit tests (`server/ts/tests/`); page rendering covered by an app test like the existing ones.
- Keep `/readings`, `/users/<id>/readings`, assignment and deletion flows unchanged.

## Out of scope (this version)
- Goal weight and progress.
- Daily/weekly averaging or smoothing.
- Exporting charts or data.
- Upstream PR (personal branch only).

## Open questions / assumptions
- All decisions above were the interviewer's recommendations, accepted by the user ("go with your recommendations").
- Water % bands and the visceral-fat convention are commonly cited rather than from a single clinical standard; the page note covers this.
- Exact query-parameter shape for chart toggles is left to implementation.
