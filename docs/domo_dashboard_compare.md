# Comparing a dashboard across Domo environments before promotion

Promoting a dashboard from sandbox to production replaces production's card definitions. Anything
changed directly in production — a card, a filter, a display setting, a Beast Mode — is lost, and a
promoted card that reads a column production's dataset view lacks will break. Run this check before
every promotion.

Ids differ per instance, so the comparison matches **cards by title**, **Beast Modes by dataset +
name** (and compares their formula text), and **datasets by name**.

## Pages

| | Sandbox | Production |
|---|---|---|
| `fte reporting` | [`randstad-sbxb` / 1981930666](https://randstad-sbxb.domo.com/page/1981930666) | [`randstad-enterprisenavigator` / 1199303900](https://randstad-enterprisenavigator.domo.com/page/1199303900) |
| `nam fte reporting` | — | [`randstad-enterprisenavigator` / 1535293568](https://randstad-enterprisenavigator.domo.com/page/1535293568) |

## Steps

1. **Extract sandbox.** Open the sandbox page in Chrome, signed in. Open DevTools (Cmd+Opt+J),
   paste all of [`scripts/domo/extract_dashboard.js`](../scripts/domo/extract_dashboard.js) and
   press Enter. It reports how many cards it copied to the clipboard. Then:

   ```bash
   pbpaste > docs/_domo_export/compare/sandbox_fte_reporting.json
   ```

2. **Extract production.** Same, on the production page:

   ```bash
   pbpaste > docs/_domo_export/compare/production_fte_reporting.json
   ```

3. **Diff.** Source is the side you promote *from*; target is the side that gets overwritten.

   ```bash
   python3 scripts/domo/compare_dashboards.py docs/_domo_export/compare/sandbox_fte_reporting.json docs/_domo_export/compare/production_fte_reporting.json --source-label sandbox --target-label production -o docs/_domo_export/compare/report_fte_reporting.md
   ```

   Exit code 0 means nothing differs. Otherwise open the report.

## Reading the report

| Section | What it means for a promotion |
|---|---|
| Cards only in one environment | A card only in production **could be lost**. A card only in sandbox gets added. |
| Cards that differ | Every production value in these tables is replaced. "production is newer" marks a card edited in production after sandbox — the usual sign of a fix made directly in production. |
| Beast Modes | A formula only in production, or with different text, may be overwritten or orphaned. |
| Dataset view columns / Breakage check | A sandbox card reading a column production's view lacks will error after promotion. Add the column to the production view first. |

Display-only differences (`display.*`, number formats, aliases) change how a card looks, not what it
computes. Filters, date ranges, `columns` that swap a Beast Mode, and formula text change the numbers.

Resolve every difference by making the two sides match — usually by copying the production change
into sandbox — then re-run until the report shows nothing.

## Comparing two pages in the same environment

The same scripts compare, say, `fte reporting` against `nam fte reporting`. Card titles on the NAM
page end in " nam", so strip that before matching:

```bash
python3 scripts/domo/compare_dashboards.py fte.json nam.json --source-label fte --target-label nam --strip-title-suffix " nam"
```

Datasets will differ by name there, so the breakage check reports them as missing — expected.

## Limits

- **Text cards** (the section headers) are counted, not compared.
- **Page-level filters and layout** are not captured.
- **What promotion replaces** — whether Beast Modes saved on a dataset are overwritten, or only card
  settings — is not confirmed. Treat both as at risk.
- **Collapsed rows** in pivot tables are lists of real names; the extractor replaces them with
  `[collapsed rows]`, so a difference there is not detected.

## How the extractor works

From a signed-in tab on the instance, using Domo's own internal endpoints (no token needed):

| Data | Call |
|---|---|
| Cards on a page | `GET /api/content/v3/stacks/<pageId>/cards?parts=metadata,metadataOverrides,datasources,drillPathURNs,subscriptions,slicers` |
| One card's full definition, including every Beast Mode on its dataset with formula text | `PUT /api/content/v3/cards/kpi/definition` with body `{"urn":"<cardId>","dynamicText":true,"variables":true}` |
| Columns a dataset view exposes | `GET /api/query/v1/datasources/<datasetId>/schema/indexed?includeHidden=false` |
| Page title | `GET /api/content/v1/pages/<pageId>` |

A formula written as `DOMO_BEAST_MODE(9474)` references another Beast Mode by its `templateId`;
the extractor resolves it from the same card definition response.
