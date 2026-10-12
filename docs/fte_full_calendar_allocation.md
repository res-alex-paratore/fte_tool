# `fte_full_calendar_allocation` — how it is built and how the dates work

Reference for the Domo Magic ETL that produces the reporting dataset
`fte_full_calendar_allocation` (dataset guid `0ce8e039-d17a-4af9-911d-6d96ff6f7e2e`).

Last checked against a dataflow export on 2026-10-08.

The same dataflow publishes two other datasets from partly shared tiles:

| Output | Fed by | Grain |
|---|---|---|
| `fte_weekly_allocation` | `Join Data 4` | one row per allocation document (no calendar skeleton) |
| **`fte_full_calendar_allocation`** | `Alter Columns 3` | **one row per (employee × fiscal Monday × cost centre)**, including employees and weeks with no allocation |
| `fte_targets` | `String Operations` | one row per weekly-targets document |

Everything below is about the middle one.

---

## 1. The one thing to understand first: the spine is Mondays

Every date in this dataset hangs off a single column, `Day`, which is **the Monday that
starts a fiscal week**, taken from `mst_blue_global_calendar_445`.

Three independent things agree on that Monday, which is why the flow works:

1. **The app** writes `weekly_allocation.allocation_date` as the Monday of the fiscal week
   (`startOfWeek(reportingWeekDate, {weekStartsOn: 1})` in
   [`multi-week-grid.tsx:38`](../src/components/allocation/multi-week-grid.tsx#L38)),
   even though the grid *displays* the Sunday week-ending date to users.
2. **The bulk branch** explodes each monthly profile onto calendar Mondays
   (`Filter Rows` → `Day of Week = 'Monday'`), choosing them by the Gregorian month of each
   week's Friday (§2.4).
3. **The skeleton** is built from the same Monday rows (`Filter Rows 3`).

So a user who sees `W/E Aug 2` in the tool is editing the row whose `Day` is `2026-07-27`.
That six-day gap is *by design*. The fiscal columns are **looked up from the calendar**; the
Gregorian month that the bulk explosion and `month_greg` use is **derived** as Monday + 4 days,
i.e. the Friday — see §3.

---

## 2. Tile-by-tile map

### 2.1 Sources

| Tile | Dataset | Notes |
|---|---|---|
| `weekly_allocation_..._APP_DB` | AppDB collection written by the Weekly Allocation grid | `allocation_amount` force-cast to DOUBLE at load |
| `consolidated_hr_fte_report_view` | HR roster (a view, `6f93982e-…`, over `consolidated_hr_fte_report`) | supplies `fte`, `department`, `manager`, `region`, `opco`, `person_id`, `start_date`, `end_date` |
| `bulk_allocation_fte_..._APP_DB` | bulk profile → employee membership | carries `allocation_monthyear` |
| `bulk_allocation_summary_..._APP_DB` | bulk profile → cost-centre split | carries `allocation_percentage`, `allocation_group` |
| `mst_blue_global_calendar_445` | master 4-4-5 calendar, **daily grain** | the only source of fiscal truth |
| `fte_cost_center_sheet` | cost-centre reference | joined on `AI level name`; supplies `Account Region`, `P&L country`, `service type`, `Opco Tagetik`, `Invoiced entity`, `cost center code report` |
| `weekly_targets_..._APP_DB` | quarterly targets | feeds `fte_targets` only |
| `fte_full_calendar_allocation_input` | **this flow's own previous output** | see §5 |

### 2.2 HR roster → one row per person

```
consolidated_hr_fte_report_view
  → Rank & Window 1   RANK() over person_id ORDER BY start_date DESC  → row_rank
  → Filter Rows 2     row_rank = 1                                    (latest record per person)
  → Select Columns    full_name, department, region, fte, manager, manager_email,
                      country→fte_country, person_email, opco, person_id, missing_flag,
                      status, start_date, end_date
  → Select Columns 6  (skeleton subset: full_name, fte, person_id, department,
                       manager, manager_email, fte_country, missing_flag,
                       status, start_date, end_date)
```

Anyone missing from the HR roster is missing from the skeleton, and so from this dataset entirely —
including any allocations already logged for them (§2.5). The HR flow drops people with a **null**
manager; see [`DASHBOARD_HANDOVER.md` §4.1](DASHBOARD_HANDOVER.md#41-consolidated_hr_fte_report-magic-etl).

### 2.3 Weekly branch

```
weekly_allocation
  → Add Formula 1     allocation_type = 'weekly'
  → Append Rows       UNION with the bulk branch (schema from the weekly side, strict = false)
  → Add Formula       allocation_name = REGEXP_REPLACE(allocation_name, '^\[.*?\]\s*', '')
                      i.e. "[12345] Jane Doe" → "Jane Doe"
  → Join Data         LEFT OUTER to HR on allocation_name = full_name
                      (HR department arrives as fte_department)
  → Rank & Window     partition (allocation_date, allocation_name, cost_center_name, allocation_type)
                      order __created__ DESC
                        rank                = RANK()
  → Add Formula 2     fte = IFNULL(fte, 1.0)
                      department = weekly ? fte_department : department
                      previous_fte_value = baseline_fte_value   (written by the app, §6.4 of the handover)
  → Alter Columns     fte, baseline_fte_value → DOUBLE
  → Join Data 4       LEFT OUTER to cost-centre guidance on cost_center_name = "AI level name"
                      ├── publishes fte_weekly_allocation
  → Group By 2        SUM(allocation_amount) grouped by ~30 descriptive columns
                      (incl. person_id, rank, correction_month, previous_fte_value)
  → Join Data 7
```

### 2.4 Bulk branch — monthly profile → weekly per-person FTE

```
bulk_allocation_fte ⨝ bulk_allocation_summary   (INNER on bulk_allocation_id)
  → Alter Columns 1   allocation_percentage → DOUBLE
  → Filter Rows 1     cost_center_name <> 'UNALLOCATED'
  → Select Columns 2
  → Group By 1        employee_count = COUNT(DISTINCT employee_name) per bulk_allocation_id
  → Join Data 5       attach employee_count
  → Join Data 2       INNER to calendar Mondays on allocation_monthyear = monthyear
                      calendar side: Filter Rows (Day of Week = 'Monday',
                                                  Calendar Reporting Year >= 2024)
                                     → Add Formula 3 monthyear =
                                         DATE_FORMAT(DATE_ADD(Day, INTERVAL 4 DAY), '%b %Y')
                      ── this is the explosion: one row per Monday whose Friday falls in that
                         Gregorian month
  → Group By          num_weeks = COUNT(DISTINCT Day) per (allocation_monthyear, bulk_allocation_id)
  → Join Data 3       attach num_weeks
  → Select Columns 1  Day → allocation_date, allocation_group → department,
                      allocation_percentage → allocation_amount, employee_name → allocation_name
  → Add Formula 4     allocation_type = 'bulk'
                      allocation_amount = allocation_amount / num_weeks / employee_count
```

So a profile holding 3.0 FTE for a client, covering 6 people, in a 4-week month,
yields `3.0 / 4 / 6 = 0.125` on each of the 4 Mondays for each of the 6 people.

### 2.5 The skeleton — why it is called "full calendar"

```
mst_blue_global_calendar_445
  → Select Columns 5  Day, Day of Week, Calendar Reporting Month, Calendar Reporting Year,
                      Reporting Month Date, Reporting Week Date
  → Filter Rows 3     Day of Week = 'Monday'
                      AND Calendar Reporting Year >= 2026
                      AND Calendar Reporting Year <= YEAR(CURRENT_DATE()) + 1
  → Add Formula 6     skeleton_cost_center = 'Unassigned', skeleton_amount = 0

Select Columns 6 (roster)  ⨯  the above     ← Join Data 6 is a CROSS JOIN
  = every employee × every in-window Monday
  → Filter Rows 5     (start_date IS NULL OR Day >= start_date)
                      AND (end_date IS NULL OR Day <= end_date)
  = every employee × every Monday they were employed, within the window
```

`Filter Rows 5` trims weeks before a person started and after they left. For anyone with no
`end_date` — i.e. everyone currently active — the skeleton still runs to the end of next year, so
**future weeks are published** (relevant to §5).

That cross join is what guarantees a row exists for a person-week even when nobody logged
anything — which is what makes `'No Logs Entered'` reporting possible.

```
  → Join Data 7       LEFT OUTER skeleton ⨝ Group By 2
                      ON (full_name, person_id, Day) = (allocation_name, person_id, allocation_date)
                      skeleton's department is renamed placeholder_department
                      allocation side's person_id, manager, manager_email, fte_country
                      are dropped — those always come from the HR roster
```

> **The skeleton is person-week grain, not person-cost-centre-week.** `cost_center_name` is not in
> that join key. So the skeleton fans out to whichever cost centres a person-week *already* has, and
> never manufactures a row for a cost centre the person holds elsewhere in the month. It emits a
> single `'Unassigned'` / `placeholder` row only when the person has **nothing at all** that week.
>
> Consequence: a person allocated to Philips in three weeks of a four-week month has **no row at all**
> for Philips in the fourth week — not a zero row. Anything downstream that divides by
> `COUNT(DISTINCT Day)` therefore divides by 3, not 4. See §6.1.

### 2.6 `Add Formula 5` — the semantics tile

Expressions run **in listed order** and later ones see earlier results. The order matters:

| # | Column | Expression | Purpose |
|---|---|---|---|
| 1 | `allocation_amount` | `NULL → 0.0` | unmatched skeleton rows become zero, not null |
| 2 | `allocation_staus` | 4-branch CASE | see §4 |
| 3 | `fte` | `fte = '1' → 1.0` | guards a string `'1'` arriving from HR |
| 4 | `cost_center_name` | `COALESCE(cost_center_name, skeleton_cost_center)` | unmatched → `'Unassigned'` |
| 5 | `rank` | `NULL → 1` | skeleton rows join the rank=1 population |
| 6 | `allocation_type` | `NULL → 'placeholder'` | tags the synthetic rows |
| 7 | `department` | `placeholder ? placeholder_department : department` | **depends on #6 having already run** |
| 8 | `person_email` | `lower(...)` | |

Reordering #6 and #7 in the Domo UI would silently break department attribution.

Then `Alter Columns 2` casts `fte` → DOUBLE, `Join Data 8` attaches
`Calendar Reporting Month Date` (INNER on `Day`), `String Operations 1` trims
`cost_center_name`, and `Add Formula 8` adds the Gregorian axis (§3).

---

## 3. The date columns — read this before writing a card

The published dataset carries **two parallel time axes**. Picking the wrong one is the single
most common source of "the numbers look wrong for August".

### Fiscal axis (4-4-5, authoritative)

| Column | Meaning |
|---|---|
| `Day` | The Monday starting the fiscal week. The join key for everything. |
| `Reporting Week Date` | **The Sunday that ends the fiscal week.** This is what the app shows as `W/E Aug 2`. Use this to label weeks. |
| `Calendar Reporting Month` / `Calendar Reporting Year` | Fiscal month/year of that Monday, looked up from the master calendar. |
| `Calendar Reporting Month Date` | Fiscal month anchor date (from `Join Data 8`). |
| `Reporting Month Date` | Fiscal month anchor date carried from `Select Columns 5`. |

### Gregorian axis (derived by arithmetic)

| Column | Expression | Meaning |
|---|---|---|
| `week_end_greg` | `DATE_ADD(Day, INTERVAL 4 DAY)` | **The Friday** of the week — a Mon–Fri business week end, *not* the fiscal Sunday. |
| `month_greg` | `DATE_TRUNC('month', week_end_greg)` | First of the Gregorian month containing that Friday. |

### Why they disagree

`month_greg` re-introduces exactly the boundary drift the fiscal axis avoids, because a fiscal
week can start in one Gregorian month and be reported in another:

| `Day` | `Reporting Week Date` | Fiscal month | `week_end_greg` | `month_greg` |
|---|---|---|---|---|
| 2026-07-27 | 2026-08-02 | **AUG 2026** | 2026-07-31 (Fri) | **2026-07-01** |
| 2026-08-03 | 2026-08-09 | AUG 2026 | 2026-08-07 | 2026-08-01 |
| 2026-08-10 | 2026-08-16 | AUG 2026 | 2026-08-14 | 2026-08-01 |
| 2026-08-17 | 2026-08-23 | AUG 2026 | 2026-08-21 | 2026-08-01 |
| 2026-08-24 | 2026-08-30 | **SEP 2026** | 2026-08-28 | **2026-08-01** |
| 2026-08-31 | 2026-09-06 | **SEP 2026** | 2026-09-04 | 2026-09-01 |

**Which axis to use.** This dataset exists for **calendar-month** reporting, so `month_greg` is
the intended grouping. The fiscal columns are there for reconciliation against finance, not for
day-to-day allocation reporting.

The Weekly Allocation grid was switched to the **same** Friday rule
([`fiscal-calendar.ts`](../src/lib/fiscal-calendar.ts), `OWNING_MONTH_OFFSET_DAYS = 4`), so the
month a user fills in is the month `month_greg` reports. If that offset is ever changed on one
side it must change on the other, or the two silently drift apart again — which is the bug that
sent the week of Mon 2026-07-27 to July while the tool showed it under August.

---

## 4. `allocation_staus` — what it actually measures

```sql
CASE
  WHEN IFNULL(allocation_amount, 0) = 0 AND fte > 0 THEN 'No Logs Entered'
  WHEN IFNULL(allocation_amount, 0) < fte           THEN 'Under-Allocated'
  WHEN IFNULL(allocation_amount, 0) > fte           THEN 'Over-Allocated'
  ELSE 'On Target'
END
```

(The column name is misspelled in the flow — `allocation_staus`, not `allocation_status`.)

It compares **one cost-centre row** against the person's **whole** FTE. At this point in the
flow the grain is one row per (person × Monday × cost centre), so a person correctly allocated
1.0 but split 0.6 / 0.4 across two clients produces **two `'Under-Allocated'` rows**.

The column is only meaningful after `allocation_amount` has been summed to the person-week
level. Any card that shows a status breakdown without that aggregation is wrong.

---

## 5. The self-referencing history mechanism

The tail of the flow reads the dataflow's **own previous output**: the LoadFromVault tile
`fte_full_calendar_allocation_input` points at dataset `0ce8e039-…`, which is the same guid the
flow publishes to.

```
fte_full_calendar_allocation_input
  → Select Columns 9   manager→historical_manager, department→historical_department,
                       manager_email→historical_manager_email, person_id, Day
  → Remove Duplicates  on the subset (person_id, Day)
  → Join Data 11       LEFT OUTER on (person_id, Day)
  → Group By 3         distinct_cc_count = COUNT(DISTINCT cost_center_name) per (person_id, Day)
  → Join Data 12       LEFT OUTER, attaches distinct_cc_count
  → Add Formula 9      department    = bulk ? department
                                            : frozen value only for past weeks (see below)
                       manager       = frozen value only for past weeks with a real manager
                       manager_email = same condition as manager
                       last_updated  = DATE_FORMAT(CURRENT_TIMESTAMP(), '%d/%m/%Y %h:%i %p')
                       assigned_fte  = fte / NULLIF(distinct_cc_count, 0)
  → Alter Columns 3    drop the three historical_* helper columns
  → PublishToVault     fte_full_calendar_allocation (REPLACE)
```

**Intent:** freeze the org structure as it was when a week was first reported, so a reorg does
not retroactively restate history. Manager and department for a past week stay as they were.

**Current rules (live in sandbox and PROD since 2026-10-12).** A week takes its frozen value only if
the week has started (`Day <= CURRENT_DATE()`) and the frozen value is real. Otherwise it takes
current HR:

```sql
-- department (non-bulk rows)
CASE
  WHEN `allocation_type` = 'bulk' THEN `department`
  WHEN `Day` > CURRENT_DATE()
    OR `historical_department` IS NULL
    OR TRIM(`historical_department`) = ''
  THEN `department`
  ELSE `historical_department`
END

-- manager; manager_email uses the same WHEN, returning manager_email / historical_manager_email
CASE
  WHEN `Day` > CURRENT_DATE()
    OR `historical_manager` IS NULL
    OR TRIM(`historical_manager`) = ''
    OR `historical_manager` = 'No manager assigned'
  THEN `manager`
  ELSE `historical_manager`
END
```

Before this, all three were plain `COALESCE(historical_x, x)`. Every week out to the end of next
year is published as soon as a person joins the roster, so the first value was frozen into future
weeks too and no HR change ever reached reporting. Weeks published before 2026-10-12 still carry
whatever was frozen then; only future weeks have been corrected.
Bulk rows are exempt from the department freeze: their `department` is the bulk
`allocation_group` (§2.4) and always comes from the current run.

`assigned_fte` is the person's FTE divided by the number of cost centres they have that week, so
it sums back to `fte` across a person-week. It is the row-level equivalent of the `fte2` Beast Mode.

**How it behaves across runs:**

- Run 1 (empty output): all `historical_*` are NULL → everything falls back to current HR.
- Run N: any (person_id, Day) that already exists keeps its **first-ever** published values.
- Future weeks are never frozen (see the rules above), so "first-ever" now means the first run on
  or after that Monday.

Consequences to keep in mind when troubleshooting — see §6.

---

## 6. Known traps and failure modes

### 6.1 The skeleton does not densify cost centres — blanks are absences, not zeros

The single most consequential one. Per §2.5, the skeleton guarantees a row per **person-week**, not
per **person-cost-centre-week**. Any reporting measure of the form
`SUM(allocation_amount) / COUNT(DISTINCT Day)` therefore divides by the weeks that *have rows*
rather than the weeks *in the month*.

This is a live bug in the Beast Mode `allocation_monthly`, used by cards `fte level allocations`
(1659132694) and `client roll up` (84279959) — see
[`domo_reporting_dashboard.md` §5.3](domo_reporting_dashboard.md). A person split across two cost
centres over-reports: their rows sum to 2.0 FTE for a 1.0 FTE person.

**Fix: the app now writes explicit zeros.** As of the change described below, a user can type `0`
into a weekly cell and it persists as a document with `allocation_amount = "0"`, so the zero reaches
this flow attached to its real cost centre and enters `COUNT(DISTINCT Day)` normally.

- Save gate — [`multi-week-grid.tsx:692`](../src/components/allocation/multi-week-grid.tsx#L692)
  writes when the value is a number `>= 0`.
- Clearing a cell to blank still `DELETE`s
  ([`:715`](../src/components/allocation/multi-week-grid.tsx#L715)) — that remains the way to
  un-allocate, and blank remains distinct from zero.
- Zero-amount documents are no longer dropped on read
  ([`:407`](../src/components/allocation/multi-week-grid.tsx#L407),
  [`:518`](../src/components/allocation/multi-week-grid.tsx#L518),
  [`:562`](../src/components/allocation/multi-week-grid.tsx#L562)).

**What this does and does not fix.** It only creates a row where a human types a `0`. A week nobody
touches still produces no row, and no existing history is corrected — so `allocation_monthly` becomes
correct for a person-cost-centre-month only once every gap week in it has been explicitly zeroed. The
symptom resolves as managers adopt the habit, not on deploy. Treat a persisting over-report as a
data-entry gap before treating it as a bug.

A downstream SQL dataflow that manufactured the missing zeros was written and then **shelved** in
favour of this — see [`domo_sql/README.md`](domo_sql/README.md). It remains a working option if the
gap-week limitation above proves unacceptable.

### 6.2 `Add Formula 5` expressions are order-dependent

Expression #6 (`allocation_type` NULL → `'placeholder'`) must run before #7 (`department` =
`placeholder ? placeholder_department : department`). Reordering them in the Domo UI silently breaks
department attribution on every skeleton row. See §2.6.

Related: any row arriving at this tile with a null `allocation_type` is stamped `'placeholder'` — and
card 1659132694's `allocation_type` slicer preselects `placeholder` in a `NOT_IN`, so such rows are
hidden by default. Anything new that feeds this tile must set `allocation_type` explicitly.

### 6.3 The history mechanism freezes the first-ever value, permanently

`Add Formula 9`'s `COALESCE(historical_department, department)` means whatever manager/department a
`(person_id, Day)` receives on its first published run wins forever. A bad run does not self-heal on
re-run; correcting it requires clearing the input dataset or a one-off run with the COALESCE bypassed.
Test structural changes against a scratch output dataset before publishing to `0ce8e039-…`.

Compounding this: which row survives `Remove Duplicates` on `(person_id, Day)` is not deterministic.
Bulk rows no longer take a frozen department, but the lookup is still built from *all* rows of the
previous output, bulk included. Where a person-week has bulk rows alongside weekly or placeholder
rows, the department frozen onto the non-bulk rows can be a bulk `allocation_group` label.

`Remove Duplicates` is confirmed to be keyed on the subset `(person_id, Day)`, so `Join Data 11`
cannot fan out.

### 6.3a Blank and future values were frozen too (fixed 2026-10-12)

Two consequences of §6.3 hit manager and department until 2026-10-12:

- **`COALESCE` only skips NULL**, so empty-string managers were frozen like real names.
- **Future weeks were frozen on first publish**, so a manager or department change in HR never
  reached reporting. Example: a person moved from Business Services RPO to MSP on 2026-08-10. HR
  and `fte_weekly_allocation` showed MSP, while every row in this dataset, 2027 included, still
  showed RPO.

The rules in §5 fix both going forward. Past weeks frozen with a stale or blank value stay as they
are. To restate one person, add a temporary line to the `department` (or manager) expression, run
once, then remove it:

```sql
WHEN `person_id` = '<id>' AND `Day` >= '<Monday the change took effect>' THEN `department`
```

**Future: effective dates.** The example above could only be fixed going forward, because nothing
in the data says the move took effect on 2026-08-10; HR shows the new department, and
`hr_roster_history` only records when the change was noticed. If an effective-date field becomes
available from an HR source, past weeks can be restated automatically: join effective-dated changes
on person and `Day >= effective_date`, which is the one-off line above, generalised. The same dates
could become real `valid_from` values in `hr_roster_history`.

**Do not filter bulk rows out of the history lookup** to stop bulk group labels being frozen as a
department. The same lookup freezes manager, and bulk-only person-weeks have no other rows, so their
past managers would be rewritten from current HR. Keeping bulk labels out of the department lookup
would need a Group By that picks department from non-bulk rows and manager from all rows.

### 6.4 The bulk explosion is on the Gregorian axis (resolved)

The export settles it: `Add Formula 3` computes
`monthyear = DATE_FORMAT(DATE_ADD(Day, INTERVAL 4 DAY), '%b %Y')`, the Gregorian month of the
week's **Friday**, matching [`fiscal-calendar.ts:18`](../src/lib/fiscal-calendar.ts#L18). So Aug 2026
lands on Mondays `{08-03, 08-10, 08-17, 08-24}`, not the fiscal `{07-27, 08-03, 08-10, 08-17}`.

Bulk rows are therefore dense on `month_greg` and not on the fiscal columns — which is what the
`nam fte reporting` dashboard (fiscal axis) sees at month boundaries.

### 6.5 The `INTERVAL 4 DAY` offset lives in two places with nothing enforcing agreement

`OWNING_MONTH_OFFSET_DAYS` in [`fiscal-calendar.ts:13`](../src/lib/fiscal-calendar.ts#L13) and
`month_greg` in `Add Formula 8`. This is the drift that sent the week of Mon 2026-07-27 to July while
the tool showed it under August (§3). Any third computation of the same rule should join a single
shared month map rather than recompute the offset.

### 6.6 `String Operations 1` trims `cost_center_name` after `Group By 2`

So `' Philips'` and `'Philips'` are distinct groups upstream and collapse into one downstream. Sums
stay correct, but any logic keyed on `cost_center_name` before that tile sees the untrimmed variants.
Moving the trim upstream of `Group By 2` would make the whole flow work on one normalised value.
`TRIM` does not address case differences — see query 7.5.

### 6.7 `last_updated` is a formatted string, not a timestamp

`Add Formula 9` writes `DATE_FORMAT(CURRENT_TIMESTAMP(), '%d/%m/%Y %h:%i %p')`. `MAX()` over it is
lexicographic (`31/01` beats `01/12`). Benign only because `PublishToVault` uses `REPLACE`, giving
every row an identical value. It would start lying if the flow ever moved to append or upsert.

### 6.8 `allocation_staus` is per-cost-centre, and misspelled

Covered in §4. It compares one cost-centre row against the person's whole FTE, so a correctly
allocated person split 0.6/0.4 produces two `'Under-Allocated'` rows. Only meaningful after
`allocation_amount` has been summed to person-week level.

---

## 7. Diagnostic queries

Read-only, against the published dataset.

### 7.1 How many person-cost-centre-months have sparse weeks (the §6.1 bug)

```sql
SELECT a.month_greg, COUNT(*) AS person_cc_months,
       SUM(CASE WHEN a.weeks_present < m.weeks_in_month THEN 1 ELSE 0 END) AS affected
FROM (SELECT person_id, cost_center_name, allocation_type, month_greg,
             COUNT(DISTINCT `Day`) AS weeks_present
      FROM fte_full_calendar_allocation
      WHERE `rank` = 1 AND allocation_type IN ('bulk','weekly')
      GROUP BY 1,2,3,4) a
JOIN (SELECT month_greg, COUNT(DISTINCT `Day`) AS weeks_in_month
      FROM fte_full_calendar_allocation GROUP BY 1) m ON a.month_greg = m.month_greg
GROUP BY 1 ORDER BY 1;
```

### 7.2 Row count if the dataset were densified to cost-centre grain

```sql
WITH m AS (SELECT month_greg, COUNT(DISTINCT `Day`) w
           FROM fte_full_calendar_allocation GROUP BY 1),
     t AS (SELECT DISTINCT person_id, cost_center_name, allocation_type, month_greg
           FROM fte_full_calendar_allocation
           WHERE `rank` = 1 AND allocation_type IN ('bulk','weekly')
             AND cost_center_name NOT IN ('Unassigned','UNALLOCATED'))
SELECT (SELECT SUM(m.w) FROM t JOIN m ON t.month_greg = m.month_greg) AS dense_target,
       (SELECT COUNT(*) FROM fte_full_calendar_allocation
          WHERE `rank` = 1 AND allocation_type IN ('bulk','weekly')
            AND cost_center_name NOT IN ('Unassigned','UNALLOCATED')) AS existing_real;
```

### 7.3 Does anything vary within a (person, cost centre, type, month)?

Any row returned is a column that cannot be treated as constant at that grain.

```sql
SELECT person_id, cost_center_name, allocation_type, month_greg,
       COUNT(DISTINCT department) d, COUNT(DISTINCT cost_center_number) n,
       COUNT(DISTINCT fte) f, COUNT(DISTINCT manager) mg
FROM fte_full_calendar_allocation WHERE `rank` = 1
GROUP BY 1,2,3,4 HAVING d > 1 OR n > 1 OR f > 1 OR mg > 1;
```

### 7.4 Which weeks do bulk rows actually land on (confirms §6.4)

```sql
SELECT month_greg, COUNT(DISTINCT `Day`) AS bulk_mondays, MIN(`Day`) AS first_monday
FROM fte_full_calendar_allocation
WHERE `rank` = 1 AND allocation_type = 'bulk' GROUP BY 1 ORDER BY 1;
```

Each `first_monday` should be the first Monday whose Friday falls in that month. One a week earlier
would mean the explosion had been changed to fiscal.

### 7.5 Cost-centre name variants (settles §6.6)

```sql
SELECT LOWER(TRIM(cost_center_name)) AS norm, COUNT(DISTINCT cost_center_name) AS variants
FROM fte_full_calendar_allocation GROUP BY 1 HAVING variants > 1;
```

### 7.6 Duplicate rows at the intended grain

Should return nothing. Anything here means a join is fanning out.

```sql
SELECT person_id, cost_center_name, allocation_type, `Day`, COUNT(*) AS n
FROM fte_full_calendar_allocation
WHERE `rank` = 1
GROUP BY 1,2,3,4 HAVING n > 1;
```
