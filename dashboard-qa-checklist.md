# QA Checklist: Health overview dashboard

> Spec: `dashboard-spec.md` · branch `windows-local` · web app v0.4.12-local.1

## Setup
- [ ] On this PC, open http://127.0.0.1:8095 in your usual browser, sign in, and reload once with **Ctrl+F5** → does the footer say **v0.4.12-local.1** (new styles and script loaded)?

## Tiles (top of the Dashboard)
- [ ] Look at the tiles at full window width → does your eye land on the big value first, then the rating, and does the page feel consistent with the other pages (Readings, Users)?
- [ ] Read your ratings: BMI **Obese**, Body Fat **Very High**, Body Water **Low**, Visceral Fat **Healthy**, Metabolic Age **Above Your Age**, Heart Rate **Normal** → do the words feel right in tone (informative rather than alarming), and are they in line with what the Withings app used to tell you?
- [ ] Look at the change line under each value (e.g. `= 0.0 kg`, `▲ 0.3 %`) → is "=" clear as "no change", or would you rather hide a zero change or write "No change"?
- [ ] Judgment call made without you: a resting heart rate **below 60 bpm** would show **Low** in amber (common in fit people) → is that the behaviour you want?
- [ ] Open **About these ranges** under the tiles → is the explanation enough, and is it in the right place?
- [ ] Click the **Partner** tab → does the "No readings recorded yet" view look intentional rather than broken?

## Charts (Trends)
- [ ] Move the mouse over several points of the **Weight** chart, including the leftmost and rightmost → does the tooltip appear right away next to the point, stay readable (not cut off at the chart edges), and disappear when you move away?
- [ ] Tick **Body Fat** under **Also Chart** → does the page update promptly with the new chart and the box still ticked? Does the jump back to the top of the page on each tick bother you?
- [ ] With your few readings, click **1 Year** and **All** → do the points bunched at the right-hand side still look sensible, or is it confusing?
- [ ] On **Body Fat**, **BMI** and **Body Water**, look at the green healthy-range band → is it visible without being distracting, and does the "Healthy range" label stay clear of the line and points?
- [ ] The vertical axis only labels the lowest and highest values (plus the band edges) → is that enough to read the chart, or do you want more gridlines?
- [ ] Judgment call made without you: only **Weight** is charted until you tick others → is that the right default, or should some (e.g. Body Fat) be on from the start?

## Keyboard
- [ ] Press **Tab** from the top of the page through the tabs, range buttons, checkboxes and into a chart → is the focus always visible, and does focusing a chart point show its tooltip?

## Narrow window
- [ ] Make the browser window as narrow as a phone (or use the browser's device view at ~375 px) → the 13 tiles stack in one column before the charts; is that scroll length acceptable, or would you prefer two tiles per row on small screens?

## Already covered (no need to check)
- Tests: values and calculated body fat %, water % and BMI; every rating band and its edges; age at the reading date; latest/previous per metric (heart rate kept when a newer weight-only reading arrives); chart markers, ranges, band, empty and single-reading cases, escaping; tabs, unknown user/range values, chart toggles keeping user and range, kg/lb display, empty states and a corrupt reading (137 server tests, type-check clean).
- Checked by Claude: rendered from your real database read-only (13 tiles, 5 charts, no broken values); screenshots at 1280 px and in a true 375 px frame (nothing cut off or overflowing); the browser runs app.js (all 81 chart markers made keyboard-focusable); new CSS served by the rebuilt server.

## Notes
<!-- Write anything that felt off here, or just tell Claude. -->
