# HR Data Issues page

`/hr-data-issues` replaces the Google Sheet for HR data problems: people missing from the tool, or
showing the wrong department, manager, title or dates. Anyone can search for a person, see what each
stage of the HR pipeline holds for them, and log an issue. Every issue is auto-assigned to a team;
admins (Domo role `Admin`) triage them. Nothing is emailed yet.

Code: `src/app/hr-data-issues/page.tsx`, `src/components/hr_data_issues/`, and the diagnosis and
routing rules in `src/lib/hr-issues.ts`.

## 1. Data it reads

| Alias | Dataset | Used for |
|---|---|---|
| `fte_hr_no_filter` | `a4b68f90-…` (`Append Rows 2` in `consolidated_hr_fte_report`) | the source rows before any filter |
| `consolidated_hr_fte_report_view` | `6f93982e-…` | the roster the tool actually uses |
| `hr_roster_history` | `9153b05c-…` | versions over time: `change_type`, `changed_fields`, `drop_reason` |
| `hr_data_quality` | `0309c504-…` | last update per HR source, shown as the strip at the top |

The three new aliases are mapped with `"fields": []`, so the Data API returns every column. Columns
the ETL adds later (`hr_source`, `source_area`, `source_l4`) appear without another manifest change.

**Gaps in `fte_hr_no_filter` today.** It has no source-system column, and it drops Dayforce `Area`
and Workday `hr_cc_reporting_hierarchy_l4`, which two source filters test. Mexico isn't in it at all.
Until the ETL change in `docs/domo_hr_history/` lands:
- the HR system is inferred from `region`, PeopleSoft's `employment_type = 'talent'` and Mexico's
  `mex` ids;
- the Dayforce Area check and the Workday L4 check show as "can't confirm";
- Mexico people show as "not in the HR feed" even when they're in the Mexico file.

## 2. Diagnosis: replaying the ETL for one person

`diagnosePerson` runs the person's rows through the same steps as the dataflow, in order, and
reports the first one that removes them.

| # | Step on the page | ETL tile | Fails when | Diagnosis |
|---|---|---|---|---|
| 1 | In HR feed | source datasets → `Append Rows 2` | no row in `fte_hr_no_filter` | `removed_from_feed` if roster history has them, otherwise `never_seen` |
| 2 | Passes HR system filter | `Filter Rows 1` (PeopleSoft `DESCR` list), `Filter Rows 2` (NAM HRIS `dept_descr` list), `Filter Rows` (Dayforce `Area = 'Delivery Center' AND Site <> 'Supply Chain'`), `Filter Rows 5` (Workday L3 list, L4 ≠ Global BPO, L5 ≠ Coaching & Outplacement) | every source row fails | `source_filter`, or `source_filter_unconfirmed` when only the missing columns could explain it |
| 3 | Has employee ID | `Filter Rows 4` | `person_id` is null (for Dayforce, the local employee ID) | `missing_employee_id` |
| 4 | Passes end-date rule | `Rank & Window 1` + `Filter Rows 6`, then `filter end dates before 6_28` | the rank-1 assignment isn't active and ended before 2026-06-28 | `assignment_rank` if a losing assignment would have passed, otherwise `end_date_cutoff` |
| 5 | In roster | `consolidated_hr_fte_report_view` | passes everything but still absent | `unknown`: check the flow has run, and the view definition |

Points that matter when reading a diagnosis:
- **NULL fails `<>` and `!=`.** A Dayforce row with a blank Site, or a Workday row with a blank L4
  or L5, is filtered out, the same as in SQL.
- **Status cleaning** copies the CASE in `cleaned status and department`. Statuses it doesn't
  recognise, such as `Leave`, pass through unchanged. The ranking sorts `cleaned_status` as text, so
  an `inactive` assignment beats a `Leave` assignment. That fits the multiple-assignment cases in the
  backlog.
- **Managers no longer drop anyone.** Null and blank managers become `No manager assigned` before
  `Filter Rows 4`, so that tile only removes null `person_id`.
- **Mexico ids are row numbers**, so Mexico people are matched on email only.

For someone who is in the roster, the page lists findings instead of a failure:
- a `missing_flag = 1` lead or manager;
- a roster end date before the cutoff;
- the source and roster disagreeing on manager;
- several source assignments sharing one ID;
- the last few roster history changes.

The comparison table highlights every field where a source row differs from the roster. Department
always differs, because the roster maps department detail to nine buckets.

## 3. Routing

Set by `routeIssue`; admins can change the team on any issue.

| Diagnosis / issue type | Team |
|---|---|
| `removed_from_feed`, `never_seen`, `source_filter`, `source_filter_unconfirmed`, `missing_employee_id` | the person's HR system team |
| `end_date_cutoff` where the source status is a recognised inactive value | the person's HR system team: HR says they left |
| `end_date_cutoff` with any other status | EDAO: our status mapping |
| `assignment_rank`, `unknown` | EDAO |
| In the roster: wrong department, manager, title, status or dates | the person's HR system team |
| In the roster: should not appear, or other | EDAO |
| No HR system known | EDAO, for triage |

HR teams: `HR – Workday India`, `HR – Dayforce EMEA/CAN`, `HR – NAM HRIS`, `HR – NAM PeopleSoft`,
`HR – Mexico feed`. Other team: `EDAO (FTE tool / ETL)`. Rename them in `HR_TEAMS` / `EDAO_TEAM`.

## 4. The `hr_data_issues` collection

AppDB, with sync on, so the synced dataset can feed cards. All fields are STRING except
`created_date`, `effective_date` and `resolved_date`, which are DATE.

| Group | Fields |
|---|---|
| Who raised it | `issue_id`, `created_date`, `reported_by`, `reported_by_email`, `raised_on_behalf_of` |
| Person | `person_id`, `person_name`, `person_email`, `hr_source`, `region`, `manager` |
| Issue | `issue_type`, `field`, `current_value`, `expected_value`, `effective_date`, `description` |
| Diagnosis at logging time | `stage`, `diagnosis`, `diagnosis_detail` |
| Triage | `assigned_team`, `status` (`new`, `in_review`, `with_team`, `resolved`, `wont_fix`), `related_ticket`, `updates` (JSON array of `{date, by, note}`), `resolution`, `resolved_date` |
| Evidence | `source_snapshot`: JSON of the person's source, roster and last five history rows when logged |

A field missing from the manifest schema never reaches the synced dataset. Add new fields to both
`HrDataIssue` in `issues-api.ts` and `public/manifest.json`.

## 5. Known limits

- The page downloads all of `fte_hr_no_filter`. If it gets slow, switch the raw lookup to a
  filtered Data API query per person.
- The roster view's definition hasn't been exported. A person diagnosed as `unknown` may be removed
  by the view.
- The weekly allocation flow joins allocations to HR on **name**. A person can be in the roster
  and still lose allocations on cards if the names differ. This page doesn't check that.
