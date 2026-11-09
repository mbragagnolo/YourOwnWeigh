# Spec: Health overview dashboard

> Tracking: none. Personal feature on `windows-local`, not intended upstream (the GitHub remote is the upstream project).

## Summary
Replace the home page's per-user tables with a health overview laid out like the Withings app: the latest weight with its change and chart at the top, a muscle/fat/bone breakdown, then one row per measurement with a rating and a range bar. Each row opens a page for that measurement with its chart over time, a labelled range bar and a one-line verdict. Ratings use published reference ranges. `/readings` stays as the full table.

## Inputs
- **Readings** (`readings` table): `measures_json` (Withings type/value/unit-exponent triples), `meastime`/`time_quality`, `user_id`. Heart rate (type 11) arrives in its own reading row with the same timestamp as the body-composition row.
- **User profile** (`users`): `height_cm`, `birth_date` or `age_years`, `sex` (0 = male, 1 = female, as in the Users form).
- **Display unit**: setting `display_weight_unit` (kg default); mass metrics follow it.
- **Query parameters** on `/`: `user` (user id, default first active user), `range` (`1m` | `3m` | `1y` | `all`, default `3m`), and `metric` (a measurement key; when present and known, `/` shows that measurement's page instead of the overview) [recommended].

## Outputs
- `GET /` renders, for one user:
  1. **User tabs** (one per active user).
  2. **Weight header**: the latest weight large, the reading date, the change since the previous weigh-in as a percentage with an arrow, and the weight chart directly below it with the range buttons 1M / 3M / 1Y / All.
  3. **Body composition bar**: one horizontal bar split into Muscle, Fat and Bone, each labelled with its share of the latest weight (muscle 76, fat mass 8, bone 88, each divided by weight 1 from the same reading). Shown only when that reading has all three [recommended].
  4. **All body measurements**: one row per measurement the user has data for, in the existing display order (weight excluded, it is in the header). Each row shows the label, the rating word under it (unrated measurements show none), the latest value with unit, and, for rated measurements, a range bar: one segment per band, equal widths, coloured by the band's tone, with a marker on the latest value. The whole row links to the measurement's page.
  5. A short note: ranges are general population references for information, not medical advice.
- `GET /?metric=<key>` renders the **measurement page**: a back link to the overview, the user tabs, a verdict line ("Your body fat is very high", or just the value for unrated measurements), the reference basis ("Reference values for men 40–59", from the same table as the rating), the latest value, its change since the previous reading, the labelled range bar (the threshold numbers written at each segment edge and the band names under the segments), and the chart for the selected range with the healthy band shaded. Range buttons keep the metric.
- No "Also chart" checkboxes any more: other measurements are charted on their own pages [user choice].
- Not built: the AI suggestions, the bell-curve population charts, and the "Stable" composition trend label from the Withings app (no source data for the curves or the trend rule) [user choice for AI suggestions; recommended for the rest].
- Charts are server-rendered inline SVG; hovering a point shows date and exact value via `server/static/app.js`.
- No change to the database, the scale protocol or the Sync API.

## Behavior
- **Latest value per metric** = the most recent reading *containing that metric type* for the user (not the latest reading overall). Same rule for "previous" when computing the delta.
- **Derived metrics**, computed per reading when the inputs exist in the same reading:
  - Body fat % = fat mass (8) / weight (1) × 100 (or type 6 if the scale sends it).
  - Water % = water mass (77) / weight (1) × 100.
  - BMI = weight / (height_cm/100)² using the user's current height.
- **Ratings** come from one data table in the code, each row with its source:

  | Metric | Basis | Bands |
  |---|---|---|
  | Body fat % | Gallagher et al. 2000, by sex and age (20–39 / 40–59 / 60–79) | Low · Healthy · High · Very high. Men 20–39: <8 / 8–20 / 20–25 / >25; 40–59: <11 / 11–22 / 22–28 / >28; 60–79: <13 / 13–25 / 25–30 / >30. Women 20–39: <21 / 21–33 / 33–39 / >39; 40–59: <23 / 23–34 / 34–40 / >40; 60–79: <24 / 24–36 / 36–42 / >42 |
  | BMI | WHO | <18.5 Underweight · 18.5–24.9 Healthy · 25–29.9 Overweight · ≥30 Obese |
  | Visceral fat index (170) | Withings app scale, out of 20, same for both sexes | <5 Good · 5–10 High · >10 Very high |
  | Water % | Commonly cited adult ranges | Men 50–65, women 45–60 Healthy; below Low; above High |
  | Heart rate (11) | AHA resting adult | <60 Low · 60–100 Normal · >100 High |
  | Metabolic age (227) | Compared with the user's actual age | ≤ age Good · > age Above your age |
  | Muscle (76), bone (88), fat-free mass (5), fat mass (8), BMR (226) | — | No rating; value and trend only |

- **Rating words** stay medical (Underweight, Healthy, Overweight, Obese, Low, High, Very high, Normal) except visceral fat, which uses the Withings scale's words [user choice].
- **Age** for banding: from `birth_date` at the reading's date when present, otherwise `age_years`.
- **Charts**: one point per reading in the selected range, x = measurement time, y = value in display units; line plus points. Shaded healthy band behind body fat %, BMI and water % (same table as the ratings, so they always agree). The weight chart is on the overview; every other chart is on its measurement's page.
- **Range bar marker**: placed inside its band's segment in proportion to where the value sits between the band's edges. The open-ended outer bands get a nominal width equal to the neighbouring band, and a value beyond that is pinned to the bar's end [recommended].
- **Delta**: latest minus previous value of the same metric, rounded to the metric's display precision; arrow up/down/flat. The weight header shows it as a percentage of the previous weight. No good/bad colouring of the delta (direction is not inherently good or bad).

## Edge cases
- User with no readings → the existing "No readings recorded yet" message, no header, bar or rows.
- No users → keep the current "No users have been added yet" state.
- Only one reading of a metric → no delta; chart shows a single point.
- No readings in the selected range → chart shows "No readings in this period" with the range buttons still usable.
- Weight-only readings (unrecognised, later assigned) → contribute to weight/BMI only.
- Weight-only user (no body composition) → header and chart only, plus BMI if height is known.
- Composition reading missing muscle, fat mass or bone → no composition bar; the rows still show.
- Age outside 20–79 → body fat % shown unrated (Gallagher covers 20–79).
- Missing height → BMI not shown.
- Unknown metric types → ignored on this page (still kept in `/readings` and the API).
- Readings with `time_quality` not trusted → plotted at received time, as the tables already do.
- Unknown `user`/`range` query values → fall back to the defaults, never an error page.
- Unknown `metric` value, or a metric the user has no data for → the overview, never an error page.

## Errors
- Bad query parameters fall back to defaults (no 400 for a dashboard view).
- Malformed stored `measures_json` for a reading → skip that reading for this page rather than failing the page.

## Constraints & dependencies
- TypeScript server-rendered HTML in the existing style (`server/ts/ui.ts` page functions, `app.ts` routes, `metrics.ts` metric table). Reuse `METRICS`, `storedMeasures`, `decimalValue`, unit formatting.
- **No new dependencies.** CSP is `script-src 'self'`: no CDN, no inline script. Inline SVG and inline styles are allowed.
- Readable in the existing light theme, with text labels on ratings (not colour alone).
- Rating thresholds and rating/derivation logic in pure functions with unit tests (`server/ts/tests/`); page rendering covered by an app test like the existing ones.
- Keep `/readings`, `/users/<id>/readings`, assignment and deletion flows unchanged.

## Out of scope (this version)
- Goal weight and progress.
- Daily/weekly averaging or smoothing.
- Exporting charts or data.
- Withings-specific bands for water, bone and lean mass (only women's screens were available).
- Upstream PR (personal branch only).

## Open questions / assumptions
- The first version's decisions were the interviewer's recommendations, accepted by the user ("go with your recommendations").
- Layout details marked [recommended] were not asked individually; the user chose the "full layout" option after sharing Withings app screenshots.
- Water % bands are commonly cited rather than from a single clinical standard, and look stricter than the Withings app's (women: app calls only <37 % Low); the page note covers this.

## Changelog
- 2026-11-09: visceral fat rated on the Withings app scale (<5 Good, 5–10 High, >10 Very high) — the user's Withings app screenshots show a fixed scale out of 20 with no sex or age band. Replaces: "1–12 Healthy · ≥13 High (common scale convention)".
- 2026-11-09: overview redesigned after the Withings app layout (weight header with chart, composition bar, measurement rows with range bars, one page per measurement), without AI suggestions or bell curves — the user prefers how the app presents the data. Replaces: "metric tiles and a chart section with 'Also chart' toggles". Rating words stay medical (user choice).
