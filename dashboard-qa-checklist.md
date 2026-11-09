# QA Checklist: Withings-style health overview

> Spec: `dashboard-spec.md` (refined) · branch `windows-local` · web app v0.4.12-local.2

## Setup
- [ ] On this PC, open http://127.0.0.1:8095 in your usual browser, sign in, and reload with **Ctrl+F5** → does the footer say **v0.4.12-local.2**?

## Overview
- [ ] Look at the page top to bottom at full window width → does it read like the Withings app (weight first, then composition, then the list), and does your eye land on the weight?
- [ ] The weight chart stops at about two-thirds of the card width on a wide window (so it doesn't grow huge) → does the empty space to its right look intentional, or would you rather it filled the card?
- [ ] Read the change line under the weight (`= 0.0 % since the previous weigh-in`) → is a percentage the right way to show it, and does "=" read as "no change"?
- [ ] Look at the **Body Composition** bar → are the three colours easy to tell apart, and is Bone (a thin sliver) still readable from its legend?
- [ ] In **All Body Measurements**, look at the range bars for BMI, Body Fat, Body Water, Visceral Fat, Metabolic Age and Heart Rate → can you tell at a glance where you sit, and is the dark marker visible on the red and yellow segments?
- [ ] The rows without a rating (Fat Mass, Muscle, Bone, BMR…) show only the value → does the list feel uneven with and without bars, or is that fine?
- [ ] Hover over a few rows → does the whole row feel clickable (highlight, pointer), and does the › make it clear it opens something?

## Measurement pages
- [ ] Click **Visceral Fat**, then **Body Fat** → does the verdict line ("Your visceral fat is in the high range") read naturally, and is the reference line under it (e.g. "Reference values for men 40–59 (Gallagher et al. 2000)") useful or noise?
- [ ] On those pages, look at the labelled range bar → are the numbers sitting over the right boundaries, and do the band names line up under their segments?
- [ ] Click **Metabolic Age** → judgment call: its bar has one dividing line (your age), with the marker placed on a scale of ±¼ of your age. Does the marker position look sensible?
- [ ] Click **Muscle Mass** (no rating) → does the page feel complete with just the value, change and chart, or empty?
- [ ] Switch the range buttons on a measurement page and use **← Overview** → do you land where you expect each time?
- [ ] Hover chart points on a measurement page, including the first and last → does the tooltip show and stay readable at the edges?

## Narrow window / phone width
- [ ] Narrow the browser window to phone width (or the browser's device view at ~375 px) and scroll the overview → do the range bars under each value look right, and are the chart's axis labels still readable? (They get very small at this width, as the old charts did.)

## Keyboard
- [ ] Press **Tab** from the top through the tabs, range buttons and measurement rows, then **Enter** on a row → is the focus always visible, and does Enter open the page?

## Partner
- [ ] Click the **Partner** tab → does "No readings recorded yet" look intentional?

## Already covered (no need to check)
- Tests (146, type-check clean): every rating band and its edges (visceral fat at exactly 5 and 10 included), ratings and bars always agreeing, marker positions, verdict sentences, composition shares and when the bar hides, the header's % change, row ratings and links, measurement pages (verdict, basis, labelled edges, chart with band, links keeping the measurement), unknown or empty measurements falling back to the overview, weight-only users, ranges, kg/lb display, empty states and a corrupt reading.
- Checked by Claude: rendered from your real database read-only (overview, Body Fat, Visceral Fat and Muscle Mass pages; Visceral Fat shows High; no broken values); screenshots at 1280 px and in a true 375 px frame (nothing cut off or overflowing); the server serves the new stylesheet.

## Notes
<!-- Write anything that felt off here, or just tell Claude. -->
