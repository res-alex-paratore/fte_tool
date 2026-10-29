#!/usr/bin/env python3
"""Generate paste-ready Magic ETL tiles that rebuild the fte_hr_no_filter union with source columns.

Why: the HR Data Issues page (docs/hr_data_issues.md) replays the consolidated HR flow for one person.
fte_hr_no_filter today has no source-system column, drops the Dayforce `Area` and Workday
`hr_cc_reporting_hierarchy_l4` columns that two source filters test, and has no Mexico branch.

The new tiles hang off the existing per-source Add Formula tiles. Paste them, point the
`fte_hr_no_filter` output at "nf append", then delete `Append Rows 2` and the four old Select Columns
it was fed by. Steps: docs/domo_hr_history/hr_source_columns.md.

Usage:
  python3 scripts/domo/hr_source_tiles.py --env sandbox
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from hr_roster_history_tiles import Flow, check  # noqa: E402

# Existing Add Formula tiles feeding the unfiltered branch. PROD ids carry the "505-" prefix Domo
# added when the flow was copied across.
BASE = {
    "workday_ind": "ExpressionEvaluator-d4bd3519-eaf5-410f-b791-f748629237ec",        # Add Formula 7
    "dayforce_emea_can": "ExpressionEvaluator-0d8adb55-835b-404f-92d7-782e005c3d71",  # Add Formula 4
    "hris_nam": "ExpressionEvaluator-8e0af03a-0e01-4333-829c-2dac9ec7a956",           # Add Formula 2
    "peoplesoft_nam": "ExpressionEvaluator-7be4054d-1d4e-45a7-ba7a-cbac2832b422",     # Add Formula 8
    "mexico": "13c8d620-c906-4e54-af4d-8b2ab98007db",                                  # Add Formula 5
}
PREFIX = {"sandbox": "", "prod": "505-"}

# Copies of the existing Select Columns (source column, published name), plus the new columns.
FIELDS = {
    # ind_wd 2
    "workday_ind": [
        ("employee_id", "person_id"), ("Worker", "full_name"), ("status", "status"), ("FTE", "fte"),
        ("country", "country"), ("region", "region"), ("missing_flag", "missing_flag"),
        ("hr_cc_reporting_hierarchy_l3", "opco"), ("hr_cc_reporting_hierarchy_l5", "department"),
        ("position_title", "title"), ("supervisory_organization", "manager"),
        ("hire_date_ee_or_contract_start_date_cw", "start_date"),
        ("end_employment_date_ee_or_contract_end_date_cw", "end_date"),
        ("worker_sub_type", "employment_type"),
        ("hr_cc_reporting_hierarchy_l4", "source_l4"),
    ],
    # emea 1
    "dayforce_emea_can": [
        ("local_employee_id", "person_id"), ("full_name", "full_name"),
        ("employment_status_name", "status"), ("employee_s_start_date", "start_date"),
        ("termination_date", "end_date"), ("missing_flag", "missing_flag"),
        ("business_email", "person_email"), ("manager_employee_number", "manager_id"),
        ("manager_name", "manager"), ("manager_electronic_address", "manager_email"),
        ("fte_value", "fte"), ("pay_class_name", "employment_type"), ("job_name", "title"),
        ("op_co", "opco"), ("Site", "department"), ("region", "region"), ("pay_group_name", "country"),
        ("Area", "source_area"),
    ],
    # us_employees 1
    "hris_nam": [
        ("EMPLID", "person_id"), ("EMPL_CLASS_DESCR", "employment_type"), ("JOBTITLE", "title"),
        ("HIRE_DT", "start_date"), ("COUNTRY", "country"), ("DEPTID", "cost_center_code"),
        ("DEPT_DESCR", "department"), ("empl_status", "status"), ("FTE", "fte"), ("OPCO", "opco"),
        ("TERMINATION_DT", "end_date"), ("SUPERVISOR_ID", "manager_id"),
        ("SUPERVISOR_NAME", "manager"), ("full_name", "full_name"), ("region", "region"),
        ("BUSN_EMAIL_ADDR", "person_email"), ("missing_flag", "missing_flag"),
        ("supervisor_email_addr", "manager_email"),
    ],
    # Select Columns 3
    "peoplesoft_nam": [
        ("EMPLID", "person_id"), ("full_name", "full_name"), ("ASSIGN STATUS", "status"),
        ("START_DATE", "start_date"), ("END_ACTUAL_DATE", "end_date"),
        ("Business Email Address", "person_email"), ("Approver Name", "manager"),
        ("Approver Email Id", "manager_email"), ("COUNTRY", "country"), ("OPCO", "opco"),
        ("DESCR", "department"), ("employment_type", "employment_type"), ("region", "region"),
        ("Job Title Description", "title"), ("missing_flag", "missing_flag"),
    ],
    # Select Columns 1 (Mexico; it also feeds the filtered union, so it is copied, not reused)
    "mexico": [
        ("Business Email", "person_email"), ("Job name", "title"), ("OpCo", "OpCo"),
        ("Area", "department_detail"), ("Site", "department"), ("Country", "country"),
        ("Manager Name", "manager"), ("Manager Email Address", "manager_email"),
        ("FTE Value", "fte"), ("Employment status name", "status"), ("Termination Date", "end_date"),
        ("full_name", "full_name"), ("region", "region"), ("missing_flag", "missing_flag"),
        ("Pay Class Name", "employment_type"), ("person_id", "person_id"),
    ],
}


def build(env_name):
    f = Flow(f"hr_source/{env_name}")
    selects = []
    for i, (source, base) in enumerate(BASE.items()):
        y = 0 + i * 96
        tagged = f.formula(f"nf {source} source", PREFIX[env_name] + base, 1248, y,
                           [("hr_source", f"'{source}'")])
        selects.append(f.select(f"nf {source} columns", tagged, 1408, y,
                                FIELDS[source] + [("hr_source", "hr_source")]))
    union = f.union("nf append", selects, 1632, 192, selects[0])
    return f, union


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", choices=PREFIX, default="sandbox")
    ap.add_argument("--out", default="docs/domo_hr_history")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    flow, _ = build(args.env)
    check(flow, {PREFIX[args.env] + b for b in BASE.values()})
    path = out / f"hr_source_{args.env}.json"
    path.write_text(json.dumps(flow.export(), separators=(",", ":")))
    print(f"wrote {path}  ({len(flow.actions)} tiles)")


if __name__ == "__main__":
    main()
