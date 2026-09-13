# -*- coding: utf-8 -*-
"""实验：碰撞产物改为「问题」而非「陈述句」。

背景：陈述句形态的碰撞产出被判定为缺乏评论欲——它与原文比信息密度是负增长，
且在知乎的内容体系里没有位置（不是回答/评论/文章，用户只能点赞或划走）。
而「问题」在知乎有完整基础设施：可被回答、关注、邀请、沉淀。

本实验对比 7 种提问策略，看哪种最能激发探索与讨论。

用法：
    python explore_question.py --nodes <实测报告目录> --out <输出目录> \
                               --pairs q5_a9:q5_a1
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from run_extract import call_llm_resilient, parse_json
from explore_collide import load_thesis

# ---------------------------------------------------------------------------
# 七种提问策略。区分两个维度：
#   向上（更本质）：卡点、前提、升维
#   向下（更具体）：场景、选择、代价
#   横向（换视角）：反转
# ---------------------------------------------------------------------------
STRATEGIES = {
    "卡点问题": {
        "desc": "两人争论到最后卡住的地方——那个不解决就无法继续往下谈的问题",
        "guide": "找出双方论证中都依赖、但谁都没有证明的那个环节，把它变成问题。",
        "axis": "向上",
    },
    "前提质疑": {
        "desc": "双方都默认成立、但其实可疑的共同前提",
        "guide": "找出两人虽然对立、却共享的隐含假设，质疑它。",
        "axis": "向上",
    },
    "升维问题": {
        "desc": "这场争论其实是某个更大问题的局部，那个更大的问题是什么",
        "guide": "跳出双方的具体分歧，提出一个涵盖两者的上层问题。",
        "axis": "向上",
    },
    "场景落地": {
        "desc": "把抽象分歧落到一个具体人群或情境上",
        "guide": "设定一个具体的人（身份、阶段、处境），问这个分歧对他意味着什么。",
        "axis": "向下",
    },
    "选择追问": {
        "desc": "把分歧压缩成一个非此即彼的二选一",
        "guide": "用「是X还是Y」的句式，逼出一个必须站队的问题。",
        "axis": "向下",
    },
    "代价追问": {
        "desc": "如果按某一方说的做，要付出什么代价",
        "guide": "问一方的主张如果成立，会带来什么被忽略的成本或后果。",
        "axis": "向下",
    },
    "反转假设": {
        "desc": "如果两人其实都对，那意味着什么",
        "guide": "假设双方的判断在各自语境下都成立，追问这说明了什么。",
        "axis": "横向",
    },
}

SYS = """你是一个「提问者」。这是知乎——一个从问题出发的平台。

给你同一个问题下两篇不同回答的核心观点，你的任务**不是**总结它们的分歧，
而是**提出一个新问题**，让读过这两篇回答的人产生继续讨论的欲望。

铁律：
1. 只输出 JSON，不要任何解释，不要 markdown 围栏。
2. 产出必须是**一个问句**，以问号结尾。
3. **不要提出原问题的同义改写**。新问题必须是原问题回答不了、
   但读完这两篇回答后才浮现出来的那个问题。
4. **不要提泛泛的问题**（「你怎么看」「如何看待」「有什么影响」）。
   好问题应当具体到有人能凭自己的经验给出实质回答。
5. 不要编造双方没说过的事实。
6. 问题长度控制在 30 字以内，越短越有力。

自检：把你的问题拿给一个读完这两篇回答的人看，他会不会想打字回复？
如果他只会点头或摇头，说明问题不好。

输出格式：
{
  "question": "你提出的新问题，≤30字，问号结尾",
  "why": "为什么这个问题值得问，≤35字",
  "who_can_answer": "什么样的人有资格回答它，≤20字"
}"""

USER_TPL = """【原问题】{question}

【回答一】{author_a}
核心观点：{claim_a}
论据要点：{points_a}

【回答二】{author_b}
核心观点：{claim_b}
论据要点：{points_b}

【提问策略】{name}
{desc}
具体做法：{guide}

按该策略提出一个新问题。只输出 JSON。"""


def brief_points(nodes, aid, limit=4):
    ps = [n["claim_text"] for n in nodes
          if n["answer_id"] == aid and n["role"] == "point"][:limit]
    return "；".join(ps) if ps else "（无）"


def ask(a, b, all_nodes, name, authors):
    s = STRATEGIES[name]
    msg = [
        {"role": "system", "content": SYS},
        {"role": "user", "content": USER_TPL.format(
            question=a.get("_question", ""),
            author_a=authors.get(a["answer_id"], a["answer_id"]),
            claim_a=a["claim_text"],
            points_a=brief_points(all_nodes, a["answer_id"]),
            author_b=authors.get(b["answer_id"], b["answer_id"]),
            claim_b=b["claim_text"],
            points_b=brief_points(all_nodes, b["answer_id"]),
            name=name, desc=s["desc"], guide=s["guide"],
        )},
    ]
    r = parse_json(call_llm_resilient(msg, verbose=False)) or {}
    return {
        "strategy": name, "axis": s["axis"],
        "question": r.get("question"), "why": r.get("why"),
        "who_can_answer": r.get("who_can_answer"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes", required=True)
    ap.add_argument("--sample")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pairs", nargs="+", required=True)
    args = ap.parse_args()

    nd = Path(args.nodes)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    theses = load_thesis(nd)
    all_nodes = []
    for f in sorted((nd / "nodes").glob("*.debug.json")):
        all_nodes += json.loads(f.read_text(encoding="utf-8"))["nodes"]

    authors = {}
    if args.sample and Path(args.sample).exists():
        for it in json.loads(Path(args.sample).read_text(encoding="utf-8")):
            authors[it["answer_id"]] = it.get("author", "")

    rows = []
    for p in args.pairs:
        ida, idb = p.split(":")
        a, b = theses[ida], theses[idb]
        for i, name in enumerate(STRATEGIES, 1):
            print(f"  [{i}/{len(STRATEGIES)}] {name}  {ida}×{idb}", flush=True)
            r = ask(a, b, all_nodes, name, authors)
            r["pair"] = f"{ida} × {idb}"
            rows.append(r)
            (out / "实验3_提问策略.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
            time.sleep(1.0)
    print(f"\n完成，写入 {out}")


if __name__ == "__main__":
    main()
