# -*- coding: utf-8 -*-
"""把一次实测的输入与输出固化成便于人工复核的快照。

用法（在 extractor/ 下执行）：
    python make_snapshot.py --input "<样本.json>" --outdir "<实测报告目录>"

产出：
    输入快照.json  —— 模型、参数、每篇输入的元信息，便于复现
    节点汇总.json  —— 全部节点拉平成一张表，便于逐条人工复核
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from run_extract import get_config


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--label", default="", help="实验名，写入快照")
    ap.add_argument("--date", default="", help="实验日期，写入快照")
    args = ap.parse_args()

    out = Path(args.outdir)
    items = json.loads(Path(args.input).read_text(encoding="utf-8"))
    cfg = get_config()

    snap = {
        "实验": args.label or out.name,
        "日期": args.date,
        "模型": cfg["model"],
        "接口": cfg["base"],
        "参数": {
            "temperature": 0.2,
            "response_format": "json_object",
            "thinking": "disabled" if "glm" in cfg["model"].lower() else "(不适用)",
            "每篇间隔秒": cfg["sleep"],
            "429重试上限": 12,
        },
        "问题": items[0].get("question", ""),
        "输入": [
            {
                "answer_id": i["answer_id"],
                "author": i.get("author", ""),
                "清洗后字数": i.get("_clean_chars", len(i["content"])),
                "原始字数": i.get("_raw_chars"),
                "正文开头": i["content"][:80].replace("\n", " ") + "...",
            }
            for i in items
        ],
    }
    (out / "输入快照.json").write_text(
        json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")

    rows = []
    for f in sorted((out / "nodes").glob("*.debug.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        for n in d["nodes"]:
            rows.append({
                "answer_id": d["answer_id"], "id": n["id"], "role": n["role"],
                "type": n["type"], "polarity": n["polarity"],
                "stance": n.get("question_stance"), "scope": n["scope"],
                "grounded": n["grounded"], "offset": n["char_offset"],
                "claim_text": n["claim_text"], "quote": n["quote"],
                "_counter": n.get("_counter"),
            })
    (out / "节点汇总.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"输入快照：{len(snap['输入'])} 篇输入")
    print(f"节点汇总：{len(rows)} 条节点")
    print(f"已写入 {out}")


if __name__ == "__main__":
    main()
