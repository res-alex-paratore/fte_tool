# Adding source columns to `fte_hr_no_filter`

The HR Data Issues page (`docs/hr_data_issues.md`) needs four things from `fte_hr_no_filter` that it
doesn't have today:
- a source-system column;
- Dayforce `Area`, for the `Area = 'Delivery Center'` filter;
- Workday `hr_cc_reporting_hierarchy_l4`, for the Global BPO exclusion;
- Mexico rows.

`hr_source_<env>.json` rebuilds the unfiltered union to add them. Generate the files with
`python3 scripts/domo/hr_source_tiles.py --env sandbox|prod`.

## What the tiles add

| Tile | Input | Adds |
|---|---|---|
| `nf <source> source` (×5) | the existing `Add Formula 7` / `4` / `2` / `8` / `5` | `hr_source` constant: `workday_ind`, `dayforce_emea_can`, `hris_nam`, `peoplesoft_nam`, `mexico` |
| `nf <source> columns` (×5) | the tile above | the same columns as `ind_wd 2`, `emea 1`, `us_employees 1`, `Select Columns 3` and `Select Columns 1`, plus `hr_source`. Workday also keeps `source_l4`, and Dayforce keeps `source_area`. |
| `nf append` | the five column tiles | the new union. Schema comes from the Workday branch, like `Append Rows 2`. |

The filtered branch and `hr_roster_history` are not touched, so the roster schema and `row_sig`
don't change.

## Applying it (sandbox first)

1. Open the `consolidated_hr_fte_report` flow, then copy the contents of `hr_source_sandbox.json`
   and paste it onto the canvas. The tiles land in the left middle area and are already joined to
   the existing Add Formula tiles.
   - In prod, use `hr_source_prod.json`. It assumes the prod tile ids carry the `505-` prefix.
   - If any `nf … source` tile pastes with no input, connect it by hand: Add Formula 7 is Workday,
     4 is Dayforce, 2 is NAM HRIS, 8 is PeopleSoft, and 5 is Mexico.
2. Disconnect the `fte_hr_no_filter` output from `Append Rows 2`, and connect it to `nf append`.
3. Delete `Append Rows 2`, `ind_wd 2`, `emea 1`, `us_employees 1` and `Select Columns 3`.
   - **Keep `Select Columns 1`:** it still feeds the filtered `Append Rows`.
   - Add Formula 7, 4, 2 and 8 now feed only the new tiles.
4. Save and run the flow.

## Checking it

```sql
SELECT hr_source, COUNT(*) AS rows_,
       SUM(CASE WHEN source_area IS NOT NULL THEN 1 ELSE 0 END) AS with_area,
       SUM(CASE WHEN source_l4  IS NOT NULL THEN 1 ELSE 0 END) AS with_l4
FROM fte_hr_no_filter
GROUP BY hr_source
```

Expect five rows:
- `with_area` is above 0 only for `dayforce_emea_can`;
- `with_l4` is above 0 only for `workday_ind`;
- the `mexico` count matches the Mexico file.

After that, open the HR Data Issues page. The "HR system inferred" note should be gone, and the
Dayforce and Workday filter checks should pass or fail instead of showing "can't confirm".
