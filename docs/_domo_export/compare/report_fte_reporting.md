# Dashboard comparison: sandbox → production

- **sandbox** (source): `randstad-sbxb.domo.com` page `1981930666` “fte reporting”, extracted 2026-10-28T18:42:41.686Z
- **production** (target, would be overwritten): `randstad-enterprisenavigator.domo.com` page `1199303900` “fte reporting”, extracted 2026-10-28T18:43:48.743Z
- Data cards: 16 vs 16 · text cards: 5 vs 5 (text card content is not compared)

## Cards only in one environment

None — every data card title exists on both sides.


## Cards that differ

Each row is a setting that differs. The production value is what a promotion would replace.

### fte_weekly_allocation

Last modified — sandbox: 2026-10-28 18:37 UTC · production: 2026-10-02 14:04 UTC

| Setting | sandbox | production |
|---|---|---|
| display.decimal_places | `null` | `"Default"` |
| display.gauge_sizing | `null` | `"Default"` |
| display.value_format | `null` | `"Default"` |

### overtime

Last modified — sandbox: 2026-10-28 18:35 UTC · production: 2026-10-15 13:07 UTC

| Setting | sandbox | production |
|---|---|---|
| main.columns | `{"formulaId": "BM:ot_allocation", "mapping": "VALUE"}`<br>`{"formulaId": "BM:ot_total", "mapping": "VALUE"}` | `{"format": {"abbreviate": false, "commas": true, "format": "###,###.0000", "percentMultiplied": true, "precision": 4, "type": "number"}, "formulaId": "BM:ot_allocation", "mapping": "VALUE"}`<br>`{"format": {"abbreviate": false, "commas": true, "format": "###,###.0000", "percentMultiplied": true, "precision": 4, "type": "number"}, "formulaId": "BM:ot_total", "mapping": "VALUE"}` |
| main.dateRangeFilter | `{"column": {"column": "Day", "exprType": "COLUMN"}, "dateTimeRange": {"count": 0, "dateTimeRangeType": "INTERVAL_OFFSET", "interval": "MONTH", "offset": 0}}` | `{"column": {"column": "Reporting Month Gregorian", "exprType": "COLUMN"}, "dateTimeRange": {"count": 0, "dateTimeRangeType": "INTERVAL_OFFSET", "interval": "MONTH", "offset": 0}}` |
| main.dateGrain | `{"column": "Day"}` | `{"column": "Reporting Month Gregorian"}` |

14 matched card(s) are identical.

## Beast Modes used by the cards

All Beast Modes used on either page have identical formula text.

## Dataset view columns

Every dataset the cards read exposes the same columns on both sides.

## Breakage check

Columns sandbox's cards read that production's dataset view lacks:

None.

## Not compared

- Text card content, page-level filters and layout
- Whether Domo's promotion replaces Beast Modes saved on the dataset, or only card settings
