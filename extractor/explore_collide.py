# -*- coding: utf-8 -*-
"""碰撞动作与主客顺序探索实验。

两个待探索问题：
  1. 除了「交锋 / 合流」，还有哪些动作值得做？
  2. 「A 拖向 B」和「B 拖向 A」是否应该产出不同结果？

设计要点：主客顺序实验必须**同一对节点、同一动作、只换主客**，
否则无法归因差异来自顺序还是来自节点本身。

用法（在 extractor/ 下执行）：
    python explore_collide.py --nodes "<实测报告目录>" --out "<输出目录>" --mode order
    python explore_collide.py --nodes "<实测报告目录>" --out "<输出目录>" --mode actions
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from run_extract import call_llm_resilient, parse_json

# ---------------------------------------------------------------------------
# 候选动作池：不预设只有两个，放开探索
# 每个动作定义：它回答什么问题、产出什么、以及是否对主客顺序敏感
# ---------------------------------------------------------------------------
ACTIONS = {
    "交锋": {
        "question": "这两个主张真正的分歧点在哪里？不是表面立场之争，而是底层预设的差异。",
        "output": "一句话点出真正的分歧所在（而非复述双方观点）",
        "order_sensitive": False,
        "note": "共识已定动作",
    },
    "合流": {
        "question": "这两个看似对立的主张，隐藏的共识是什么？",
        "output": "一句话说出双方其实都同意的那件事",
        "order_sensitive": False,
        "note": "共识已定动作",
    },
    "追问": {
        "question": "以 A 的立场，向 B 提出一个 B 最难回答的问题。",
        "output": "一个具体的问句，指向 B 论证中最薄弱的环节",
        "order_sensitive": True,
        "note": "探索：天然有方向性，A 问 B 与 B 问 A 必然不同",
    },
    "让步": {
        "question": "A 需要承认 B 的哪一点，才能让自己的主张依然成立？",
        "output": "一句话：A 承认某点后，其主张收缩到什么范围仍然有效",
        "order_sensitive": True,
        "note": "探索：主动方是让步方，方向性强",
    },
    "归因": {
        "question": "两人为什么会得出不同结论？差异来自立场、信息还是经验范围？",
        "output": "一句话指出分歧的来源类型",
        "order_sensitive": False,
        "note": "探索：解释分歧成因，而非判定对错",
    },
    "夹逼": {
        "question": "在什么条件下 A 成立、什么条件下 B 成立？",
        "output": "一句话划出两者各自的适用边界",
        "order_sensitive": False,
        "note": "探索：把对立转为分工，需要 scope 支撑",
    },
    "升维": {
        "question": "这两个主张争论的其实是一个更大问题的两个侧面，那个更大的问题是什么？",
        "output": "一句话提出上层问题",
        "order_sensitive": False,
        "note": "探索：产出新的公共知识节点，最贴合产品定位",
    },
    "验真": {
        "question": "B 这个具体案例，是支持还是反驳了 A 的主张？",
        "output": "一句话判定，并说明案例的哪个细节起了决定作用",
        "order_sensitive": True,
        "note": "共识中属 claim×experience，此处测其顺序敏感性",
    },
}

SYS = """你是一个「观点碰撞推导器」。给你两个来自不同作者的观点节点，
你要执行指定的碰撞动作，推导出一个新的知识节点。

铁律：
1. 只输出 JSON，不要任何解释文字，不要 markdown 围栏。
2. 新节点的 claim_text 不超过 45 字，必须是一句独立可读的陈述。
3. **严禁复述双方原话**。如果你的输出只是「A 认为X，B 认为Y」，那是失败的。
   必须产出一个双方原话里都没有的新判断。
4. 严禁编造双方没说过的事实。推导只能基于给定的两个节点。
5. 如果这两个节点在你看来根本无法产生有意义的碰撞，
   诚实地把 collidable 设为 false 并说明原因，不要硬凑。

输出格式：
{
  "collidable": true,
  "claim_text": "推导出的新节点，≤45字",
  "reason": "一句话说明推导依据，≤40字",
  "quality_self_check": "这句话是不是双方原话的复述？若是，说明失败"
}"""

USER_TPL = """【问题】{question}

【主动方 A】（用户拖动的那个节点）
作者：{author_a}
主张：{claim_a}
类型：{type_a}   立场：{stance_a}   适用范围：{scope_a}
原文：「{quote_a}」

【被动方 B】（被拖向的那个节点）
作者：{author_b}
主张：{claim_b}
类型：{type_b}   立场：{stance_b}   适用范围：{scope_b}
原文：「{quote_b}」

【碰撞动作】{action}
{action_question}

【产出要求】{action_output}

注意：A 是主动方，B 是被动方。如果这个动作有方向性，
请严格按照「A 作用于 B」的方向推导，不要反过来。

只输出 JSON。"""


def load_thesis(nodes_dir: Path) -> dict:
    """读取一个实测目录下所有回答的 thesis。"""
    out = {}
    for f in sorted((nodes_dir / "nodes").glob("*.debug.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        th = next((n for n in d["nodes"] if n["role"] == "thesis"), None)
        if th:
            th["_question"] = d.get("question", "")
            out[d["answer_id"]] = th
    return out


def load_all_nodes(nodes_dir: Path) -> dict:
    out = {}
    for f in sorted((nodes_dir / "nodes").glob("*.debug.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        for n in d["nodes"]:
            n["_question"] = d.get("question", "")
            out[n["id"]] = n
    return out


def collide(a: dict, b: dict, action: str, authors: dict) -> dict:
    spec = ACTIONS[action]
    msg = [
        {"role": "system", "content": SYS},
        {"role": "user", "content": USER_TPL.format(
            question=a.get("_question", ""),
            author_a=authors.get(a["answer_id"], a["answer_id"]),
            claim_a=a["claim_text"], type_a=a["type"],
            stance_a=a.get("question_stance") or "-", scope_a=a.get("scope") or "未说明",
            quote_a=(a.get("quote") or "")[:70],
            author_b=authors.get(b["answer_id"], b["answer_id"]),
            claim_b=b["claim_text"], type_b=b["type"],
            stance_b=b.get("question_stance") or "-", scope_b=b.get("scope") or "未说明",
            quote_b=(b.get("quote") or "")[:70],
            action=action,
            action_question=spec["question"],
            action_output=spec["output"],
        )},
    ]
    txt = call_llm_resilient(msg, verbose=False)
    r = parse_json(txt) or {}
    return {
        "action": action,
        "A": a["id"], "B": b["id"],
        "A_claim": a["claim_text"], "B_claim": b["claim_text"],
        "A_stance": a.get("question_stance"), "B_stance": b.get("question_stance"),
        "collidable": r.get("collidable"),
        "result": r.get("claim_text"),
        "reason": r.get("reason"),
        "self_check": r.get("quality_self_check"),
    }


def exp_order(theses, authors, pairs, out: Path):
    """实验一：主客顺序是否产生差异。

    同一对节点、同一动作，只交换 A/B 位置，跑两次。
    """
    rows = []
    total = len(pairs) * len(ACTIONS)
    i = 0
    for (ida, idb) in pairs:
        a, b = theses[ida], theses[idb]
        for act in ACTIONS:
            i += 1
            print(f"  [{i}/{total*2}] {act} {ida}→{idb}", flush=True)
            fwd = collide(a, b, act, authors)
            time.sleep(1.0)
            i += 1
            print(f"  [{i}/{total*2}] {act} {idb}→{ida}", flush=True)
            rev = collide(b, a, act, authors)
            time.sleep(1.0)
            rows.append({
                "pair": f"{ida} × {idb}",
                "action": act,
                "order_sensitive_expected": ACTIONS[act]["order_sensitive"],
                "forward": {"dir": f"{ida}→{idb}", "result": fwd["result"],
                            "reason": fwd["reason"], "collidable": fwd["collidable"]},
                "reverse": {"dir": f"{idb}→{ida}", "result": rev["result"],
                            "reason": rev["reason"], "collidable": rev["collidable"]},
            })
            (out / "实验1_主客顺序.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return rows


def exp_actions(theses, authors, pairs, out: Path):
    """实验二：八个候选动作在同一对节点上的产出对比。"""
    rows = []
    total = len(pairs) * len(ACTIONS)
    i = 0
    for (ida, idb) in pairs:
        a, b = theses[ida], theses[idb]
        for act in ACTIONS:
            i += 1
            print(f"  [{i}/{total}] {act}  {ida}→{idb}", flush=True)
            r = collide(a, b, act, authors)
            r["note"] = ACTIONS[act]["note"]
            rows.append(r)
            time.sleep(1.0)
            (out / "实验2_动作对比.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes", required=True, help="实测报告目录（含 nodes/）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sample", help="样本 json，用于取作者名")
    ap.add_argument("--mode", choices=["order", "actions", "both"], default="both")
    ap.add_argument("--pairs", nargs="*", help="形如 q5_a1:q5_a2，可多组")
    args = ap.parse_args()

    nd = Path(args.nodes)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    theses = load_thesis(nd)
    authors = {}
    if args.sample and Path(args.sample).exists():
        for it in json.loads(Path(args.sample).read_text(encoding="utf-8")):
            authors[it["answer_id"]] = it.get("author", "")

    if args.pairs:
        pairs = [tuple(p.split(":")) for p in args.pairs]
    else:
        yes = [k for k, v in theses.items() if v.get("question_stance") == "yes"]
        no = [k for k, v in theses.items() if v.get("question_stance") == "no"]
        pairs = [(yes[0], no[0])] if yes and no else []

    if not pairs:
        print("[X] 没有可用配对")
        return
    print(f"配对：{pairs}")
    print(f"动作池：{list(ACTIONS)}\n")

    if args.mode in ("actions", "both"):
        print("=== 实验二：动作对比 ===")
        exp_actions(theses, authors, pairs, out)
    if args.mode in ("order", "both"):
        print("\n=== 实验一：主客顺序 ===")
        exp_order(theses, authors, pairs, out)
    print(f"\n结果已写入 {out}")


if __name__ == "__main__":
    main()
