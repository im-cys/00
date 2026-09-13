# -*- coding: utf-8 -*-
"""把全部抽取结果导出成一份可直接阅读的 Markdown 清单。

用户要「直观看到做得怎么样」，JSON 不适合人读，导出成分层 md：
问题 → 回答 → thesis → group → node，每个 node 带 quote 与反对句。

用法（在 extractor/ 下执行）：
    python export_readable.py --map q1=<dir> q5=<dir> ... --samples <标准样本目录> --out <文件.md>
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(d: Path):
    out = []
    for f in sorted((d / "nodes").glob("*.debug.json"),
                    key=lambda p: (len(p.stem), p.stem)):
        out.append(json.loads(f.read_text(encoding="utf-8")))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", nargs="+", required=True, help="qid=目录")
    ap.add_argument("--samples", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    sd = Path(args.samples)
    lines = ["# 全量抽取结果清单", "",
             "由 `export_readable.py` 自动生成。每个节点包含：断言、类型、原文引用、反对句。", ""]

    stat_rows = []
    for spec in args.map:
        qid, path = spec.split("=", 1)
        ds = load(Path(path))
        authors = {}
        sf = sd / f"{qid}_样本.json"
        if sf.exists():
            for it in json.loads(sf.read_text(encoding="utf-8")):
                authors[it["answer_id"]] = it.get("author", "")

        q = ds[0]["question"] if ds else qid
        n_node = sum(len(d["nodes"]) for d in ds)
        n_scope = sum(1 for d in ds for n in d["nodes"] if n.get("scope"))
        stat_rows.append((qid, q, len(ds), n_node, n_scope))

        lines += [f"---", "", f"## {qid}　{q}", "",
                  f"共 {len(ds)} 篇回答，{n_node} 个节点。", ""]

        # thesis 总览表：最直观
        lines += ["### thesis 总览", "",
                  "| 回答 | 作者 | stance | thesis |", "|---|---|---|---|"]
        for d in ds:
            th = next((n for n in d["nodes"] if n["role"] == "thesis"), None)
            if not th:
                continue
            lines.append(f"| {d['answer_id']} | {authors.get(d['answer_id'],'')} | "
                         f"`{th.get('question_stance')}` | {th['claim_text']} |")
        lines.append("")

        for d in ds:
            aid = d["answer_id"]
            th = next((n for n in d["nodes"] if n["role"] == "thesis"), None)
            lines += [f"### {aid}　{authors.get(aid,'')}", ""]
            if th:
                sc = th.get("scope") or "—"
                lines += [f"**THESIS**（stance=`{th.get('question_stance')}` "
                          f"type=`{th['type']}` grounded=`{th['grounded']}`）",
                          "", f"> **{th['claim_text']}**", "",
                          f"- 原文：「{th['quote']}」" + (f" @{th['char_offset']}" if th['char_offset'] is not None else ""),
                          f"- scope：{sc}",
                          f"- 反对：{th.get('_counter')}", ""]
            for g in d["groups"]:
                ns = [n for n in d["nodes"]
                      if n["group_id"] == g["group_id"] and n["role"] == "point"]
                lines.append(f"**G{g['order']}　{g['title']}**　—— {g['summary']}"
                             f"　`{len(ns)} node`")
                lines.append("")
                if not ns:
                    lines += ["> 〈空 group：这一段是铺垫，无硬主张〉", ""]
                for n in ns:
                    lines += [f"- **{n['claim_text']}**",
                              f"  - `{n['type']}` / `{n['polarity']}`"
                              f" / scope: {n.get('scope') or '—'}",
                              f"  - 原文：「{n['quote']}」",
                              f"  - 反对：{n.get('_counter')}"]
                lines.append("")

    head = ["", "## 总览", "",
            "| 问题 | 标题 | 回答数 | 节点数 | scope 已填 |", "|---|---|---|---|---|"]
    for qid, q, a, n, s in stat_rows:
        head.append(f"| {qid} | {q[:26]} | {a} | {n} | {s}/{n} |")
    head += ["", f"**合计 {sum(r[2] for r in stat_rows)} 篇回答，"
                 f"{sum(r[3] for r in stat_rows)} 个节点**", ""]

    Path(args.out).write_text("\n".join(lines[:3] + head + lines[3:]), encoding="utf-8")
    print(f"已写入 {args.out}")
    print(f"合计 {sum(r[2] for r in stat_rows)} 篇 / {sum(r[3] for r in stat_rows)} 节点")


if __name__ == "__main__":
    main()
