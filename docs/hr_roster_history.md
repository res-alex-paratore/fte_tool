# `hr_roster_history` — design and build spec

A new output on the `consolidated_hr_fte_report` Magic ETL that records every change to the HR
roster with a timestamp, and that also serves the current roster.

Status: **proposed**, to be built and tested in sandbox first. Nothing downstream reads it yet.

---

## 1. What it gives you

One row per **version** of a person. A new version is written whenever anything tracked about them
changes, when they drop out of the roster, and when they come back.

| Question | Query |
|---|---|
| Who is on the roster right now? | `is_current = 1 AND present_flag = 1` (should match `consolidated_hr_fte_report`) |
| What changed, and when? | `change_type <> 'keep'` ordered by `valid_from`; `changed_fields` names the columns |
| Who was this person's manager on date X? | `valid_from <= X AND (valid_to IS NULL OR valid_to > X)` |
| Who dropped out, and why? | `change_type = 'dropped'`, with `drop_reason` |

### Columns

All columns from the published roster, plus:

| Column | Meaning |
|---|---|
| `person_key` | Stable identity for the person (§3.1). The key for everything below. |
| `row_sig` | All tracked attributes joined into one string. A version changes when this changes. |
| `valid_from` | When this version was first seen (the ETL run time). |
| `valid_to` | When it was replaced. NULL = still the open version. |
| `is_current` | 1 on the open version, 0 on closed ones. |
| `present_flag` | 1 if the person is on the roster in this version; 0 on a "dropped" marker row. |
| `change_type` | `initial`, `new`, `changed`, `dropped`, `returned`. |
| `changed_fields` | For `changed`: comma-separated list, e.g. `manager,manager_email`. |
| `drop_reason` | For `dropped`: `not in source` (gone from the HR feed) or `filtered out` (still in the feed, removed by this flow's filters). |
| `first_seen` | `valid_from` of the person's first-ever version. |

### Timestamps are when we *noticed*, not HR effective dates

`valid_from` is the time of the ETL run that first saw the change. Its precision is the flow's run
frequency. A change HR backdates by a month shows up as of the day the feed changed. That suits
"when did our reporting data change" — the purpose here — but it is not an HR audit trail.

---

## 2. How it works

Each run:

1. Build this run's roster, from the same tile that feeds `consolidated_hr_fte_report`.
2. Load the previous `hr_roster_history`. Closed versions are passed through untouched.
3. FULL OUTER JOIN this run's roster to the previous **open** versions on `person_key`, and classify
   each person:

| Current run | Previous open version | Action |
|---|---|---|
| present | none | **new** → insert a version |
| present | present, same `row_sig` | **keep** → previous version stays open |
| present | present, different `row_sig` | **changed** → close previous, insert a version |
| present | dropped marker | **returned** → close the marker, insert a version |
| absent | present, and their region has rows this run | **dropped** → close previous, insert a dropped marker |
| absent | present, but their region has **no** rows this run | **keep** (§3.3) |
| absent | dropped marker | **keep** |

4. Append closed history + kept versions + closed versions + inserts + dropped markers, and publish
   with **REPLACE**.

---

## 3. Design decisions

### 3.1 `person_key`, not `person_id`

Mexico's `person_id` is `CONCAT('mex', row_num)` ordered by email, so it changes whenever the Mexico
file gains or loses a row. Keyed on `person_id`, every Mexico person would churn through
dropped/new versions. Mexico is keyed on email instead:

```sql
CASE
  WHEN `person_id` LIKE 'mex%' THEN CONCAT('mex:', LOWER(TRIM(`person_email`)))
  ELSE `person_id`
END
```

Everyone else keeps `person_id`, matching what the rest of the reporting uses. **Check before
building** that ids don't collide across sources — query 6.1.

### 3.2 What counts as a change

Tracked in `row_sig`: `full_name`, `manager`, `manager_email`, `manager_id`, `department`,
`department_detail`, `title`, `fte`, `cleaned_status`, `employment_type`, `country`, `region`,
`opco`, `cost_center_code`, `person_email`, `start_date`, `end_date`, `missing_flag`.

Raw `status` is left out because `cleaned_status` covers it and raw values churn. Add or remove
columns by editing the `row_sig` expression. Changing it makes everyone show as `changed` once, on
the next run.

### 3.3 A missing source does not drop a whole region

If a source dataset fails to load or arrives empty, every person in that region disappears from the
run at once. Without a guard the history would log hundreds of `dropped` rows, then hundreds of
`returned` rows the next day. The flow counts rows per `region` this run, and only marks someone
dropped if their region still has rows. If a whole region is missing, its people's versions stay
open.

The guard works per region, not per source. NAM has three sources (PeopleSoft, NAM HRIS, Mexico), so
one of those failing on its own is **not** caught.

### 3.4 Why history and current roster live in one dataset

The current roster is just the open versions. Keeping both in one place means the "latest" view and
the log can never disagree. It also opens a later option: the calendar flow's
first-value-wins freeze could be replaced by an as-of join on this table (§7).

### 3.5 Self-reference risk, and the insurance copy

Like the calendar flow, this output is only as good as its previous run. A run that publishes
something broken becomes the input to the next. Two mitigations:

- **Test in sandbox** and compare against `consolidated_hr_fte_report` every run until it is
  trusted (§6).
- **Optional: `hr_roster_snapshots`** — a second output, **APPEND**, writing this run's roster with
  `run_ts` on every run. It needs no self-reference, so it can't be corrupted by a bad run, and the
  whole history can be rebuilt from it. Cost: one roster's worth of rows per run.

---

## 4. Build spec

Tile names are suggestions. "←" gives each tile's input.

### Phase 1 — bootstrap (run once)

A self-referencing input needs its dataset to exist first. So the first build publishes the
current roster as the initial history:

1. **`hist current`** — Add Formula ← `Remove Duplicates` (the tile feeding
   `consolidated_hr_fte_report`).
   - `person_key` — §3.1
   - `row_sig` — §4.1
   - `run_ts` — `CURRENT_TIMESTAMP()`
2. **`hist dedupe`** — Remove Duplicates ← `hist current`, on `person_key`. A guard; it should
   remove nothing (query 6.2).
3. **`hist initial`** — Add Formula ← `hist dedupe`.
   - `valid_from` — `` `run_ts` ``
   - `valid_to` — `CAST(NULL AS TIMESTAMP)` (or `NULL`, then set to datetime in step 4)
   - `is_current` — `1`
   - `present_flag` — `1`
   - `change_type` — `'initial'`
   - `changed_fields` — `CAST(NULL AS STRING)`
   - `drop_reason` — `CAST(NULL AS STRING)`
   - `first_seen` — `` `run_ts` ``
4. **Alter Columns** — `valid_from`, `valid_to`, `first_seen` → DATETIME. Without this, `valid_to`
   can be typed as text and later unions fail.
5. **Publish** `hr_roster_history`, REPLACE. Run the flow once.

### Phase 2 — full logic

Remove `hist initial` and its Alter Columns, then add:

**Prior history**

6. **`hr_roster_history`** — Load (the dataset just published).
7. **`hist prior closed`** — Filter ← 6: `valid_to IS NOT NULL`. Goes straight to the final append.
8. **`hist prior open`** — Filter ← 6: `valid_to IS NULL`.
9. **`hist prior prefixed`** — Select Columns ← 8. **Every** column renamed with a `p_` prefix
   (`person_key` → `p_person_key`, `manager` → `p_manager`, `valid_from` → `p_valid_from`, …). This
   stops name clashes in the join.

**Guards**

10. **`hist region rows`** — Group By ← `hist dedupe`: group `region`, `COUNT(*)` as `region_rows`.
11. **`hist source keys`** — Add Formula ← `Append Rows` (the pre-filter union): `person_key` (§3.1).
12. **`hist source present`** — Group By ← 11: group `person_key`, `COUNT(*)` as `in_source`.

**Compare and classify**

13. **`hist compare`** — Join ← `hist dedupe` **FULL OUTER** `hist prior prefixed` on
    `person_key = p_person_key`.
14. **`hist region join`** — Join ← 13 LEFT `hist region rows` on `p_region = region`. In the
    join's column settings, drop the right-hand `region` so the current row's `region` is kept.
15. **`hist source join`** — Join ← 14 LEFT `hist source present` on `p_person_key = person_key`.
    Drop the right-hand `person_key`.
16. **`hist classify`** — Add Formula ← 15. Order matters; later expressions use earlier ones.
    - `run_ts` — `CURRENT_TIMESTAMP()` (recomputed so dropped rows, which have no current side,
      get one too)
    - `action` — §4.2
    - `changed_fields` — §4.3
    - `drop_reason` —
      ```sql
      CASE WHEN `action` = 'dropped'
           THEN CASE WHEN `in_source` IS NULL THEN 'not in source' ELSE 'filtered out' END
      END
      ```

**Route to the four outputs**

17. **Keep** — Filter ← 16: `action = 'keep'`. Then Select Columns: the `p_` columns renamed back
    without the prefix. (The previous open version, unchanged.)
18. **Close** — Filter ← 16: `action IN ('changed','dropped','returned')`. Add Formula:
    `p_valid_to` = `` `run_ts` ``, `p_is_current` = `0`. Then Select Columns: `p_` columns renamed back.
19. **Insert** — Filter ← 16: `action IN ('new','changed','returned')`. Add Formula:
    - `valid_from` = `` `run_ts` ``, `valid_to` = `CAST(NULL AS TIMESTAMP)`
    - `is_current` = `1`, `present_flag` = `1`
    - `change_type` = `` `action` ``
    - `first_seen` = ``COALESCE(`p_first_seen`, `run_ts`)``
    - `drop_reason` = `CAST(NULL AS STRING)`

    Then Select Columns: the **current-side** (unprefixed) roster columns plus these, dropping all
    `p_` columns.
20. **Dropped marker** — Filter ← 16: `action = 'dropped'`. Add Formula:
    - `p_valid_from` = `` `run_ts` ``, `p_valid_to` = `CAST(NULL AS TIMESTAMP)`
    - `p_is_current` = `1`, `p_present_flag` = `0`
    - `p_change_type` = `'dropped'`, `p_changed_fields` = `CAST(NULL AS STRING)`
    - `p_drop_reason` = `` `drop_reason` ``

    Then Select Columns: `p_` columns renamed back. (The last known attributes, flagged as absent.)

**Publish**

21. **Append Rows** ← 7, 17, 18, 19, 20. Use 19 as the schema source.
22. **Alter Columns** — `valid_from`, `valid_to`, `first_seen` → DATETIME.
23. **Publish** `hr_roster_history`, REPLACE (same dataset as step 5).

Optional insurance (§3.5): **Publish** `hist dedupe` → `hr_roster_snapshots`, **APPEND**.

### 4.1 `row_sig`

```sql
CONCAT(
  IFNULL(`full_name`, ''),                                   '|',
  IFNULL(`manager`, ''),                                     '|',
  IFNULL(`manager_email`, ''),                               '|',
  IFNULL(CAST(`manager_id` AS STRING), ''),                  '|',
  IFNULL(`department`, ''),                                  '|',
  IFNULL(`department_detail`, ''),                           '|',
  IFNULL(`title`, ''),                                       '|',
  IFNULL(CAST(`fte` AS STRING), ''),                         '|',
  IFNULL(`cleaned_status`, ''),                              '|',
  IFNULL(`employment_type`, ''),                             '|',
  IFNULL(`country`, ''),                                     '|',
  IFNULL(`region`, ''),                                      '|',
  IFNULL(`opco`, ''),                                        '|',
  IFNULL(`cost_center_code`, ''),                            '|',
  IFNULL(LOWER(`person_email`), ''),                         '|',
  IFNULL(DATE_FORMAT(`start_date`, '%Y-%m-%d'), ''),         '|',
  IFNULL(DATE_FORMAT(`end_date`, '%Y-%m-%d'), ''),           '|',
  IFNULL(CAST(`missing_flag` AS STRING), '')
)
```

Every term is wrapped in `IFNULL` because one NULL makes the whole `CONCAT` NULL. If the editor
rejects `CAST(… AS STRING)`, use `CAST(… AS CHAR)`.

### 4.2 `action`

```sql
CASE
  WHEN `p_person_key` IS NULL                         THEN 'new'
  WHEN `person_key` IS NULL AND `p_present_flag` = 0  THEN 'keep'
  WHEN `person_key` IS NULL AND IFNULL(`region_rows`, 0) = 0 THEN 'keep'
  WHEN `person_key` IS NULL                           THEN 'dropped'
  WHEN `p_present_flag` = 0                           THEN 'returned'
  WHEN `row_sig` = `p_row_sig`                        THEN 'keep'
  ELSE 'changed'
END
```

### 4.3 `changed_fields`

Builds `,manager,department` and strips the leading comma.

```sql
CASE WHEN `action` = 'changed' THEN SUBSTRING(CONCAT(
  CASE WHEN IFNULL(`manager`,'')           <> IFNULL(`p_manager`,'')           THEN ',manager'           ELSE '' END,
  CASE WHEN IFNULL(`manager_email`,'')     <> IFNULL(`p_manager_email`,'')     THEN ',manager_email'     ELSE '' END,
  CASE WHEN IFNULL(`department`,'')        <> IFNULL(`p_department`,'')        THEN ',department'        ELSE '' END,
  CASE WHEN IFNULL(`department_detail`,'') <> IFNULL(`p_department_detail`,'') THEN ',department_detail' ELSE '' END,
  CASE WHEN IFNULL(`title`,'')             <> IFNULL(`p_title`,'')             THEN ',title'             ELSE '' END,
  CASE WHEN IFNULL(CAST(`fte` AS STRING),'') <> IFNULL(CAST(`p_fte` AS STRING),'') THEN ',fte'           ELSE '' END,
  CASE WHEN IFNULL(`cleaned_status`,'')    <> IFNULL(`p_cleaned_status`,'')    THEN ',cleaned_status'    ELSE '' END,
  CASE WHEN IFNULL(`country`,'')           <> IFNULL(`p_country`,'')           THEN ',country'           ELSE '' END,
  CASE WHEN IFNULL(`region`,'')            <> IFNULL(`p_region`,'')            THEN ',region'            ELSE '' END,
  CASE WHEN IFNULL(`opco`,'')              <> IFNULL(`p_opco`,'')              THEN ',opco'              ELSE '' END,
  CASE WHEN IFNULL(`full_name`,'')         <> IFNULL(`p_full_name`,'')         THEN ',full_name'         ELSE '' END,
  CASE WHEN IFNULL(CAST(`manager_id` AS STRING),'') <> IFNULL(CAST(`p_manager_id` AS STRING),'') THEN ',manager_id' ELSE '' END,
  CASE WHEN IFNULL(`employment_type`,'')   <> IFNULL(`p_employment_type`,'')   THEN ',employment_type'   ELSE '' END,
  CASE WHEN IFNULL(`cost_center_code`,'')  <> IFNULL(`p_cost_center_code`,'')  THEN ',cost_center_code'  ELSE '' END,
  CASE WHEN IFNULL(LOWER(`person_email`),'') <> IFNULL(LOWER(`p_person_email`),'') THEN ',person_email'  ELSE '' END,
  CASE WHEN IFNULL(DATE_FORMAT(`start_date`,'%Y-%m-%d'),'') <> IFNULL(DATE_FORMAT(`p_start_date`,'%Y-%m-%d'),'') THEN ',start_date' ELSE '' END,
  CASE WHEN IFNULL(DATE_FORMAT(`end_date`,'%Y-%m-%d'),'')   <> IFNULL(DATE_FORMAT(`p_end_date`,'%Y-%m-%d'),'')   THEN ',end_date'   ELSE '' END,
  CASE WHEN IFNULL(CAST(`missing_flag` AS STRING),'') <> IFNULL(CAST(`p_missing_flag` AS STRING),'') THEN ',missing_flag' ELSE '' END
), 2) END
```

This list must cover every column in `row_sig`. A `changed` row with an empty `changed_fields` means
the two have drifted apart.

---

## 5. Things to know

- **Cost.** Each run does one FULL OUTER join of the roster against itself plus two small joins —
  cheap at roster size. The dataset grows only by the number of changes.
- **Renaming a tracked column upstream** breaks the `p_` mapping in steps 9, 17, 18 and 20. Change
  all four together.
- **A person whose `person_key` changes** (new employee id, Mexico email change) shows as one
  `dropped` and one `new`. History can't link them on its own.
- **Region on dropped markers** uses the last known region, so a dropped marker stays in the right
  region's counts.

---

## 6. Testing in sandbox

Run each of these after every run until the output is trusted.

### 6.1 Before building: does `person_key` collide across sources?

Against `fte_hr_no_filter`, with the §3.1 expression as `person_key`:

```sql
SELECT person_key, COUNT(DISTINCT region) AS regions, COUNT(*) AS n
FROM fte_hr_no_filter
GROUP BY person_key
HAVING COUNT(DISTINCT region) > 1;
```

Rows here mean two sources share an id. Then `person_key` needs a source prefix (e.g.
`CONCAT(region, ':', person_id)`), which the rest of reporting doesn't use — decide before building.

### 6.2 Exactly one open version per person

```sql
SELECT person_key, COUNT(*) FROM hr_roster_history
WHERE valid_to IS NULL GROUP BY person_key HAVING COUNT(*) > 1;
```

Must be empty.

### 6.3 Current roster matches `consolidated_hr_fte_report`

```sql
SELECT COUNT(*) FROM hr_roster_history WHERE is_current = 1 AND present_flag = 1;
```

Must equal the row count of `consolidated_hr_fte_report` from the same run.

### 6.4 A second run with no source changes writes nothing

Run the flow twice in a row. The second run should add no rows:

```sql
SELECT change_type, COUNT(*) FROM hr_roster_history
WHERE valid_from >= '<time of second run>' GROUP BY change_type;
```

Anything returned means `row_sig` isn't stable between runs — typically a timestamp, a float
rendering, or a non-deterministic `Remove Duplicates` pick.

### 6.5 Daily change log

```sql
SELECT DATE(valid_from) AS day, change_type, region, COUNT(*) AS n
FROM hr_roster_history
WHERE change_type IN ('new','changed','dropped','returned')
GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3;
```

A spike of `dropped` concentrated in one region on one day is a source problem, not real attrition.

---

## 7. Later, once trusted

- Point `consolidated_hr_fte_report_view` (or a new view) at the open versions, so the app and the
  calendar flow read the same roster that history is built from.
- Replace the calendar flow's first-value-wins freeze (`Add Formula 9`) with an as-of lookup: join
  on `person_key`, then keep the version where `valid_from <= Day < valid_to`. That gives history
  that is correct *and* self-healing. History only begins at the bootstrap run, though, so weeks
  before it still need the current freeze or a backfill rule.
- A dashboard card over §6.5, to see source problems as they happen.
