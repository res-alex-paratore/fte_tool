#!/usr/bin/env python3
"""Generate paste-ready Magic ETL tiles for the hr_roster_history branch.

Design: docs/hr_roster_history.md. Output is the "domo/dataflow-entities" clipboard format,
so each file can be copied and pasted straight onto the consolidated HR flow's canvas.

  phase 1  bootstrap: roster columns -> keys -> dedupe -> initial version -> output columns
  phase 2  full logic: reads hr_roster_history back in and writes new / changed / dropped / returned

Usage:
  python3 scripts/domo/hr_roster_history_tiles.py --env sandbox
  python3 scripts/domo/hr_roster_history_tiles.py --env sandbox --history-guid <guid of hr_roster_history>
"""
import argparse
import json
import uuid
from pathlib import Path

# Existing tiles the branch hangs off. PROD tile ids carry the prefix Domo added when the flow was
# copied across.
ENVS = {
    "sandbox": {
        "remove_duplicates": "Unique-fd7183eb-8b9c-4e6c-9faf-7fd57604c207",
        "append_rows": "UnionAll-12f50fcf-7247-4a77-ac76-6065739406c2",
    },
    "prod": {
        "remove_duplicates": "505-Unique-fd7183eb-8b9c-4e6c-9faf-7fd57604c207",
        "append_rows": "505-UnionAll-12f50fcf-7247-4a77-ac76-6065739406c2",
    },
}
GUID_PLACEHOLDER = "REPLACE-WITH-HR-ROSTER-HISTORY-GUID"

# Columns published by consolidated_hr_fte_report (minus the assignment_rank helper).
ROSTER = [
    "person_id", "full_name", "status", "employment_type", "opco", "department", "title",
    "manager_id", "manager", "manager_email", "person_email", "start_date", "end_date",
    "country", "cost_center_code", "cleaned_status", "fte", "region", "department_detail",
    "missing_flag",
]
HISTORY = ["person_key"] + ROSTER + [
    "row_sig", "valid_from", "valid_to", "is_current", "present_flag",
    "change_type", "changed_fields", "drop_reason", "first_seen",
]

PERSON_KEY = """CASE
  WHEN `person_id` LIKE 'mex%' THEN CONCAT('mex:', LOWER(TRIM(`person_email`)))
  ELSE `person_id`
END"""

# (column, how to render it as text). Shared by row_sig and changed_fields so the two can't drift.
TRACKED = [
    ("full_name", "`{c}`"),
    ("manager", "`{c}`"),
    ("manager_email", "`{c}`"),
    ("manager_id", "CAST(`{c}` AS STRING)"),
    ("department", "`{c}`"),
    ("department_detail", "`{c}`"),
    ("title", "`{c}`"),
    ("fte", "CAST(`{c}` AS STRING)"),
    ("cleaned_status", "`{c}`"),
    ("employment_type", "`{c}`"),
    ("country", "`{c}`"),
    ("region", "`{c}`"),
    ("opco", "`{c}`"),
    ("cost_center_code", "`{c}`"),
    ("person_email", "LOWER(`{c}`)"),
    ("start_date", "DATE_FORMAT(`{c}`, '%Y-%m-%d')"),
    ("end_date", "DATE_FORMAT(`{c}`, '%Y-%m-%d')"),
    ("missing_flag", "CAST(`{c}` AS STRING)"),
]


def as_text(col, prefix=""):
    tmpl = dict(TRACKED)[col]
    return tmpl.format(c=prefix + col)


ROW_SIG = "CONCAT(\n" + ",\n  '|',\n".join(
    f"  IFNULL({as_text(c)}, '')" for c, _ in TRACKED
) + "\n)"

CHANGED_FIELDS = (
    "CASE WHEN `action` = 'changed' THEN SUBSTRING(CONCAT(\n"
    + ",\n".join(
        f"  CASE WHEN IFNULL({as_text(c)}, '') <> IFNULL({as_text(c, 'p_')}, '') "
        f"THEN ',{c}' ELSE '' END"
        for c, _ in TRACKED
    )
    + "\n), 2) END"
)

ACTION = """CASE
  WHEN `p_person_key` IS NULL THEN 'new'
  WHEN `person_key` IS NULL AND `p_present_flag` = 0 THEN 'keep'
  WHEN `person_key` IS NULL AND IFNULL(`region_rows`, 0) = 0 THEN 'keep'
  WHEN `person_key` IS NULL THEN 'dropped'
  WHEN `p_present_flag` = 0 THEN 'returned'
  WHEN `row_sig` = `p_row_sig` THEN 'keep'
  ELSE 'changed'
END"""

DROP_REASON = """CASE WHEN `action` = 'dropped'
  THEN CASE WHEN `in_source` IS NULL THEN 'not in source' ELSE 'filtered out' END
END"""

NULL_TS = "CAST(NULL AS TIMESTAMP)"
NULL_STR = "CAST(NULL AS STRING)"


class Flow:
    def __init__(self, env_name):
        self.env_name = env_name
        self.actions = []
        self.nodes = []

    def _base(self, kind, name, inputs, x, y):
        # Deterministic, so a phase 2 generated later still points at the phase 1 tiles already pasted.
        tid = f"{kind}-{uuid.uuid5(uuid.NAMESPACE_URL, f'hr_roster_history/{self.env_name}/{name}')}"
        self.nodes.append({"id": tid, "type": "Tile", "x": x, "y": y})
        return tid, {
            "name": name,
            "id": tid,
            "dependsOn": {str(i): {"actionId": a, "outputId": None} for i, a in enumerate(inputs)},
            "disabled": False,
            "removeByDefault": False,
            "notes": [],
            "settings": {"preferredDatabaseEntityType": "TEMP_VIEW"},
        }

    def _gui(self, tid, x, y, **extra):
        return {"id": tid, "type": "Tile", "x": x, "y": y, "color": None, "colorSource": None, **extra}

    def _add(self, a):
        a.setdefault("previewRowLimit", None)
        self.actions.append(a)
        return a["id"]

    def formula(self, name, inp, x, y, exprs):
        tid, a = self._base("ExpressionEvaluator", name, [inp], x, y)
        a.update({
            "type": "ExpressionEvaluator",
            "expressions": [{"expression": e, "fieldName": f, "settings": {}} for f, e in exprs],
            "gui": self._gui(tid, x, y, sampleJson=None),
            "input": inp,
            "tables": [{"name": name, "id": tid, "previewRowLimit": None}],
        })
        return self._add(a)

    def select(self, name, inp, x, y, fields):
        tid, a = self._base("SelectValues", name, [inp], x, y)
        a.update({
            "type": "SelectValues",
            "fields": [{"name": src, "rename": "" if src == dst else dst} for src, dst in fields],
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def filter(self, name, inp, x, y, expr):
        tid, a = self._base("Filter", name, [inp], x, y)
        a.update({
            "type": "Filter",
            "filterList": [{"expression": expr, "andFilterList": []}],
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def unique(self, name, inp, x, y, cols):
        tid, a = self._base("Unique", name, [inp], x, y)
        a.update({
            "type": "Unique",
            "countRows": False,
            "fields": [{"name": c, "caseInsensitive": False} for c in cols],
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def count_by(self, name, inp, x, y, group, out):
        tid, a = self._base("GroupBy", name, [inp], x, y)
        a.update({
            "type": "GroupBy",
            "addLineNumber": False,
            "lineNumberFieldname": None,
            "giveBackRow": False,
            "allRows": False,
            "partitionedAggregation": False,
            "groups": [{"name": group}],
            "fields": [{"name": out, "source": None, "type": None, "valuefield": None,
                        "expression": "COUNT(*)", "settings": None}],
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def join(self, name, left, right, x, y, join_type, k1, k2, drop_right=()):
        tid, a = self._base("MergeJoin", name, [left, right], x, y)
        a.update({
            "type": "MergeJoin",
            "joinType": join_type,
            "step1": left,
            "step2": right,
            "keys1": k1,
            "keys2": k2,
            "on": None,
            "schemaModification1": [],
            "schemaModification2": [{"name": c, "rename": "", "remove": True} for c in drop_right],
            "relationshipType": "MTM",
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def union(self, name, inputs, x, y, schema_source):
        tid, a = self._base("UnionAll", name, inputs, x, y)
        a.update({
            "type": "UnionAll",
            "unionType": "INCLUDE_ALL",
            "schemaSource": schema_source,
            "strict": False,
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def alter(self, name, inp, x, y, types):
        tid, a = self._base("Metadata", name, [inp], x, y)
        a.update({
            "type": "Metadata",
            "fields": [{"name": c, "rename": None, "type": t, "dateFormat": None, "settings": {},
                        "remove": False} for c, t in types],
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def load(self, name, guid, x, y):
        tid, a = self._base("LoadFromVault", name, [], x, y)
        a.update({
            "type": "LoadFromVault",
            "dataSourceId": guid,
            "executeFlowWhenUpdated": False,
            "onlyLoadNewVersions": False,
            "recentVersionCutoffMs": 0,
            "columnSettings": {},
            "visiblePartitionColumn": "",
            "versionWindow": None,
            "previewRowLimit": 10000,
            "propagateAi": False,
            "filterGroupIds": [],
            "sourceType": "AUTO",
            "filterPolicy": "LEGACY",
            "gui": self._gui(tid, x, y),
        })
        return self._add(a)

    def export(self):
        return {
            "contentType": "domo/dataflow-entities",
            "data": {
                "nodes": self.nodes,
                "actions": self.actions,
                "actionColors": {a["id"]: {"color": None, "colorSource": None} for a in self.actions},
                "sections": [],
                "comments": [],
            },
        }


def same(cols):
    return [(c, c) for c in cols]


def unprefix(cols):
    return [(f"p_{c}", c) for c in cols]


OUT_TYPES = [("valid_from", "DATETIME"), ("valid_to", "DATETIME"), ("first_seen", "DATETIME"),
             ("is_current", "LONG"), ("present_flag", "LONG")]


def phase1(env_name, env):
    f = Flow(env_name)
    rd = env["remove_duplicates"]
    y = 544
    cols = f.select("hist roster columns", rd, 2208, y, same(ROSTER))
    cur = f.formula("hist current", cols, 2336, y, [
        ("person_key", PERSON_KEY), ("row_sig", ROW_SIG), ("run_ts", "CURRENT_TIMESTAMP()"),
    ])
    dd = f.unique("hist dedupe", cur, 2464, y, ["person_key"])
    init = f.formula("hist initial", dd, 2592, y, [
        ("valid_from", "`run_ts`"), ("valid_to", NULL_TS), ("is_current", "1"),
        ("present_flag", "1"), ("change_type", "'initial'"), ("changed_fields", NULL_STR),
        ("drop_reason", NULL_STR), ("first_seen", "`run_ts`"),
    ])
    out = f.select("hist output columns", init, 4032, y, same(HISTORY))
    f.alter("hist alter", out, 4160, y, OUT_TYPES)
    return f, {"hist dedupe": dd, "hist output columns": out}


def phase2(env_name, env, history_guid, p1):
    f = Flow(env_name)
    dedupe, out_cols = p1["hist dedupe"], p1["hist output columns"]

    prior = f.load("hr_roster_history", history_guid, 2208, 800)
    p_open = f.filter("hist prior open", prior, 2336, 800, "`valid_to` IS NULL")
    p_closed = f.filter("hist prior closed", prior, 2336, 928, "`valid_to` IS NOT NULL")
    p_pref = f.select("hist prior prefixed", p_open, 2464, 800, [(c, f"p_{c}") for c in HISTORY])

    regions = f.count_by("hist region rows", dedupe, 2592, 672, "region", "region_rows")
    src_keys = f.formula("hist source keys", env["append_rows"], 2336, 1056, [("person_key", PERSON_KEY)])
    src_present = f.count_by("hist source present", src_keys, 2464, 1056, "person_key", "in_source")

    cmp_ = f.join("hist compare", dedupe, p_pref, 2720, 544, "FULL OUTER",
                  ["person_key"], ["p_person_key"])
    rj = f.join("hist region join", cmp_, regions, 2848, 544, "LEFT OUTER",
                ["p_region"], ["region"], drop_right=["region"])
    sj = f.join("hist source join", rj, src_present, 2976, 544, "LEFT OUTER",
                ["p_person_key"], ["person_key"], drop_right=["person_key"])
    cls = f.formula("hist classify", sj, 3104, 544, [
        ("run_ts", "CURRENT_TIMESTAMP()"),
        ("action", ACTION),
        ("changed_fields", CHANGED_FIELDS),
        ("drop_reason", DROP_REASON),
    ])

    keep_f = f.filter("hist keep", cls, 3232, 416, "`action` = 'keep'")
    keep_s = f.select("hist keep restore", keep_f, 3360, 416, unprefix(HISTORY))

    close_f = f.filter("hist close", cls, 3232, 544, "`action` IN ('changed', 'dropped', 'returned')")
    close_a = f.formula("hist close set valid_to", close_f, 3360, 544, [
        ("p_valid_to", "`run_ts`"), ("p_is_current", "0"),
    ])
    close_s = f.select("hist close restore", close_a, 3488, 544, unprefix(HISTORY))

    ins_f = f.filter("hist insert", cls, 3232, 672, "`action` IN ('new', 'changed', 'returned')")
    ins_a = f.formula("hist insert set version", ins_f, 3360, 672, [
        ("valid_from", "`run_ts`"), ("valid_to", NULL_TS), ("is_current", "1"),
        ("present_flag", "1"), ("change_type", "`action`"),
        ("first_seen", "COALESCE(`p_first_seen`, `run_ts`)"), ("drop_reason", NULL_STR),
    ])
    ins_s = f.select("hist insert current values", ins_a, 3488, 672, same(HISTORY))

    drp_f = f.filter("hist dropped", cls, 3232, 800, "`action` = 'dropped'")
    drp_a = f.formula("hist dropped set marker", drp_f, 3360, 800, [
        ("p_valid_from", "`run_ts`"), ("p_valid_to", NULL_TS), ("p_is_current", "1"),
        ("p_present_flag", "0"), ("p_change_type", "'dropped'"),
        ("p_changed_fields", NULL_STR), ("p_drop_reason", "`drop_reason`"),
    ])
    drp_s = f.select("hist dropped restore", drp_a, 3488, 800, unprefix(HISTORY))

    union = f.union("hist append", [ins_s, keep_s, close_s, drp_s, p_closed], 3744, 544, ins_s)
    return f, union, out_cols


def check(flow, external):
    ids = {a["id"] for a in flow.actions}
    for a in flow.actions:
        for dep in a["dependsOn"].values():
            assert dep["actionId"] in ids or dep["actionId"] in external, (a["name"], dep)
    assert {n["id"] for n in flow.nodes} == ids


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", choices=ENVS, default="sandbox")
    ap.add_argument("--history-guid", default=GUID_PLACEHOLDER,
                    help="dataset id of hr_roster_history, known after phase 1 has run")
    ap.add_argument("--out", default="docs/domo_hr_history")
    args = ap.parse_args()
    env = ENVS[args.env]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    f1, p1 = phase1(args.env, env)
    check(f1, {env["remove_duplicates"]})
    f2, union, out_cols = phase2(args.env, env, args.history_guid, p1)
    check(f2, {env["append_rows"], *p1.values()})

    for name, flow in (("phase1", f1), ("phase2", f2)):
        path = out / f"{name}_{args.env}.json"
        path.write_text(json.dumps(flow.export(), separators=(",", ":")))
        print(f"wrote {path}  ({len(flow.actions)} tiles)")
    if args.history_guid == GUID_PLACEHOLDER:
        print("phase 2 still has the placeholder dataset id; rerun with --history-guid after phase 1 runs")


if __name__ == "__main__":
    main()
