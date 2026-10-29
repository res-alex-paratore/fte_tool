#!/usr/bin/env python3
"""Diff two Domo dashboard extracts and report what a promotion would overwrite or break.

Why: promoting a dashboard from one instance to another replaces the target's card definitions.
Anything changed directly in the target (a card, a filter, a Beast Mode) is lost, and a promoted card
that reads a column the target's dataset view lacks breaks. Ids differ per instance, so this matches
cards by title, Beast Modes by dataset + name, and datasets by name.

Extracts come from scripts/domo/extract_dashboard.js. Steps: docs/domo_dashboard_compare.md.

Usage:
  python3 scripts/domo/compare_dashboards.py SOURCE.json TARGET.json [-o report.md]
      [--source-label sandbox] [--target-label production] [--strip-title-suffix " nam"]

SOURCE is the side being promoted from; TARGET is the side that would be overwritten.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

LIST_FIELDS = ("columns", "filters", "groupBy", "orderBy")


def dump(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def load(path, suffix):
    data = json.loads(Path(path).read_text())
    cards, text = {}, 0
    for c in data["cards"]:
        if c["type"] == "Text":
            text += 1
            continue
        title = c["title"].strip()
        if suffix and title.endswith(suffix):
            title = title[: -len(suffix)].strip()
        cards[title] = c
    return data, cards, text


def list_delta(a, b):
    a, b = a or [], b or []
    sa, sb = [dump(x) for x in a], [dump(x) for x in b]
    return [x for x in sa if x not in sb], [x for x in sb if x not in sa]


def card_diffs(s, t):
    """Field-level differences between one card in source (s) and target (t)."""
    out = []
    for key in ("chart", "datasets", "description", "dynamicTitle", "drillPaths"):
        if dump(s.get(key)) != dump(t.get(key)):
            out.append((key, dump(s.get(key)), dump(t.get(key))))
    for key in ("columnAliases",):
        if dump(s.get(key)) != dump(t.get(key)):
            out.append((key, dump(s.get(key)), dump(t.get(key))))
    for key in ("slicers",):
        only_s, only_t = list_delta(s.get(key), t.get(key))
        if only_s or only_t:
            out.append((key, "\n".join(only_s) or "—", "\n".join(only_t) or "—"))
    if dump(s.get("overrides")) != dump(t.get("overrides")):
        so, to = (s.get("overrides") or [{}])[0], (t.get("overrides") or [{}])[0]
        for k in sorted(set(so) | set(to)):
            if so.get(k) != to.get(k):
                out.append((f"display.{k}", dump(so.get(k)), dump(to.get(k))))
    ss, ts = s.get("subscriptions", {}), t.get("subscriptions", {})
    for name in sorted(set(ss) | set(ts)):
        if name not in ss or name not in ts:
            out.append((f"{name} (subscription)", "present" if name in ss else "absent",
                        "present" if name in ts else "absent"))
            continue
        a, b = ss[name], ts[name]
        for key in LIST_FIELDS:
            only_s, only_t = list_delta(a.get(key), b.get(key))
            if only_s or only_t:
                out.append((f"{name}.{key}", "\n".join(only_s) or "—", "\n".join(only_t) or "—"))
        for key in ("dateRangeFilter", "dateGrain", "limit"):
            if dump(a.get(key)) != dump(b.get(key)):
                out.append((f"{name}.{key}", dump(a.get(key)), dump(b.get(key))))
    return out


def referenced_columns(card):
    cols = set()
    for sub in card.get("subscriptions", {}).values():
        for key in LIST_FIELDS:
            for item in sub.get(key) or []:
                col = item.get("column")
                if col and not col.startswith(("BM:", "calculation_")) and not item.get("calendar"):
                    cols.add(col)
        drf = (sub.get("dateRangeFilter") or {}).get("column", {}).get("column")
        if drf:
            cols.add(drf)
    for sl in card.get("slicers") or []:
        cols.add(sl["column"])
    return cols


def when(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if ms else "unknown"


def cell(text):
    return "<br>".join(f"`{line}`" for line in str(text).replace("|", "\\|").split("\n"))


def report(src_path, tgt_path, sl, tl, suffix):
    src, s_cards, s_text = load(src_path, suffix)
    tgt, t_cards, t_text = load(tgt_path, suffix)
    lines = [
        f"# Dashboard comparison: {sl} → {tl}",
        "",
        f"- **{sl}** (source): `{src['instance']}` page `{src['pageId']}` “{src['pageTitle']}”, "
        f"extracted {src['extractedAt']}",
        f"- **{tl}** (target, would be overwritten): `{tgt['instance']}` page `{tgt['pageId']}` "
        f"“{tgt['pageTitle']}”, extracted {tgt['extractedAt']}",
        f"- Data cards: {len(s_cards)} vs {len(t_cards)} · text cards: {s_text} vs {t_text} "
        "(text card content is not compared)",
        "",
    ]
    risks = 0

    only_t = sorted(set(t_cards) - set(s_cards))
    only_s = sorted(set(s_cards) - set(t_cards))
    lines += ["## Cards only in one environment", ""]
    if not only_t and not only_s:
        lines += ["None — every data card title exists on both sides.", ""]
    for title in only_t:
        risks += 1
        lines.append(f"- **{title}** — only in {tl}. **Could be lost** if the promotion replaces the page.")
    for title in only_s:
        lines.append(f"- **{title}** — only in {sl}. Would be added to {tl}.")
    lines.append("")

    lines += ["## Cards that differ", "",
              f"Each row is a setting that differs. The {tl} value is what a promotion would replace.", ""]
    differing = 0
    for title in sorted(set(s_cards) & set(t_cards)):
        diffs = card_diffs(s_cards[title], t_cards[title])
        if not diffs:
            continue
        differing += 1
        risks += 1
        s_mod, t_mod = s_cards[title].get("modified"), t_cards[title].get("modified")
        newer = f" — **{tl} is newer**" if (s_mod or 0) < (t_mod or 0) else ""
        lines += [f"### {title}", "", f"Last modified — {sl}: {when(s_mod)} · {tl}: {when(t_mod)}{newer}", "",
                  f"| Setting | {sl} | {tl} |", "|---|---|---|"]
        lines += [f"| {k} | {cell(a)} | {cell(b)} |" for k, a, b in diffs]
        lines.append("")
    same = len(set(s_cards) & set(t_cards)) - differing
    lines += [f"{same} matched card(s) are identical.", ""]

    lines += ["## Beast Modes used by the cards", ""]
    sf, tf = src["formulas"], tgt["formulas"]
    rows = []
    for key in sorted(set(sf) | set(tf)):
        if sf.get(key) == tf.get(key):
            continue
        rows.append(f"| {key} | {cell(sf.get(key) or '— absent')} | {cell(tf.get(key) or '— absent')} |")
    if rows:
        risks += len(rows)
        lines += [f"| Dataset :: name | {sl} | {tl} |", "|---|---|---|", *rows]
    else:
        lines.append("All Beast Modes used on either page have identical formula text.")
    lines.append("")

    lines += ["## Dataset view columns", ""]
    schema_rows = []
    for ds in sorted(set(src["schemas"]) | set(tgt["schemas"])):
        a, b = set(src["schemas"].get(ds, [])), set(tgt["schemas"].get(ds, []))
        if a != b:
            schema_rows.append(f"| {ds} | {', '.join(sorted(a - b)) or '—'} | {', '.join(sorted(b - a)) or '—'} |")
    if schema_rows:
        lines += [f"| Dataset | only in {sl} | only in {tl} |", "|---|---|---|", *schema_rows]
    else:
        lines.append("Every dataset the cards read exposes the same columns on both sides.")
    lines.append("")

    lines += ["## Breakage check", "", f"Columns {sl}'s cards read that {tl}'s dataset view lacks:", ""]
    broken = []
    for title, card in sorted(s_cards.items()):
        for ds in set(card["datasets"]):
            missing = referenced_columns(card) - set(tgt["schemas"].get(ds, []))
            if ds in tgt["schemas"] and missing:
                broken.append(f"- **{title}** ({ds}): {', '.join(sorted(missing))}")
            elif ds not in tgt["schemas"]:
                broken.append(f"- **{title}**: dataset `{ds}` is not read by any card in {tl} — check it exists")
    risks += len(broken)
    lines += broken or ["None."]
    lines += ["", "## Not compared", "",
              "- Text card content, page-level filters and layout",
              "- Whether Domo's promotion replaces Beast Modes saved on the dataset, or only card settings",
              ""]
    return "\n".join(lines), risks


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("source")
    p.add_argument("target")
    p.add_argument("-o", "--output")
    p.add_argument("--source-label", default="source")
    p.add_argument("--target-label", default="target")
    p.add_argument("--strip-title-suffix", default="",
                   help='strip this from card titles before matching, e.g. " nam"')
    args = p.parse_args()
    text, risks = report(args.source, args.target, args.source_label, args.target_label,
                         args.strip_title_suffix)
    if args.output:
        Path(args.output).write_text(text)
        print(f"Wrote {args.output} — {risks} difference(s) to review")
    else:
        print(text)
    sys.exit(1 if risks else 0)


if __name__ == "__main__":
    main()
