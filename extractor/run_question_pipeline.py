# -*- coding: utf-8 -*-
"""二审提问链路：上下文包 → 提问 → evidence 回查闸门。

与一审 explore_question.py 的区别：
  1. 输入从「光秃秃的 claim_text」换成 ContextPack（含 quote / group / 原文窗口）；
  2. prompt 增加【引用铁律】与 evidence 字段；
  3. 产出经 question_validator 回查，对不上原文的整条丢弃。

用法：
    python run_question_pipeline.py --nodes <抽取输出目录> --sample <样本json>
                                    --out <输出目录> --pairs q2_a9:q2_a3 [...]
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from run_extract import call_llm_resilient, parse_json
from context_pack import build_context_pack, render_pack
from question_validator import validate_question

# ---------------------------------------------------------------------------
# 提问策略。二审收敛为 3 条：一条向上（更本质）、一条向下（更具体）、一条横向。
# 依据：一审 7 策略中「卡点问题」产出脱离人的处境而失败，
# 且向上/向下/横向三轴内部的策略差异远小于轴间差异。
# ---------------------------------------------------------------------------
STRATEGIES = {
    "前提质疑": {
        "axis": "向上（更本质）",
        "desc": "双方都默认成立、但其实可疑的共同前提",
        "guide": "找出两人虽然对立、却共享的隐含假设，质疑它。",
    },
    "场景落地": {
        "axis": "向下（更具体）",
        "desc": "把抽象分歧落到一个具体人群或情境上",
        "guide": ("设定一个具体的人或情境，问这个分歧对他意味着什么。"
                  "注意：这个人群或情境必须来自原文片段，不许自己发明。"),
    },
    "代价追问": {
        "axis": "横向（换视角）",
        "desc": "如果按某一方说的做，要付出什么代价",
        "guide": "问一方的主张如果成立，会带来什么被忽略的成本或后果。",
    },
}

SYS = """你是一个「提问者」。这是知乎——一个从问题出发的平台。

给你同一个问题下两篇不同回答的核心观点，**以及它们各自的原文片段**。
你的任务不是总结分歧，而是**提出一个新问题**，让读过这两篇回答的人产生继续讨论的欲望。

铁律：
1. 只输出 JSON，不要任何解释，不要 markdown 围栏。
2. 产出必须是**一个问句**，以问号结尾。
3. 不要提出原问题的同义改写。新问题必须是原问题回答不了、
   但读完这两篇回答后才浮现出来的那个问题。
4. 不要提泛泛的问题（「你怎么看」「如何看待」「有什么影响」）。
   好问题应当具体到有人能凭自己的经验给出实质回答。
5. 问题长度控制在 35 字以内，越短越有力。
6. 自检：把你的问题拿给一个读完这两篇回答的人看，他会不会想打字回复？
   如果他只会点头或摇头，说明问题不好。

7.【引用铁律 —— 最重要的一条】
   你的问题里出现的每一个具体元素——数字、专有名词、身份标签、时间点、场景词——
   都必须能在我给你的**原文片段**中找到出处。

   你必须在 evidence 数组中列出你依据的原文片段（逐字摘录，每条 10-60 字，最多 3 条）。
   每条 evidence 必须是原文中**连续的一段话**，不得把不相邻的两句拼接在一起，
   不得加省略号、不得跨段落拼接。系统会把 evidence 拿回原文做字符串校验，
   对不上的问题会被整条丢弃。

   特别警告：不要引入原文没有的社会情绪词。
   典型的编造：「35岁」「转行」「被裁员」「内卷」「焦虑」「中年危机」——
   除非原文真的出现了这些词，否则一律不许用。
   这类词很有煽动性，但它们不来自这两篇回答，属于伪造论据。

   如果你发现自己想写的问题在原文里找不到支撑，
   说明这两个节点碰不出好问题，请输出：
   {"question": null, "reason": "无法从给定材料生成有据的问题"}
   允许失败，不允许编造。

输出格式：
{
  "question": "你提出的新问题，≤35字，问号结尾",
  "evidence": ["逐字摘自原文片段的依据1", "依据2"],
  "why": "为什么这个问题值得问，≤35字",
  "who_can_answer": "什么样的人有资格回答它，≤20字"
}"""

USER_TPL = """【原问题】{question}

{pack_a}

────────────────────────────

{pack_b}

────────────────────────────

【提问策略】{name}（{axis}）
{desc}
具体做法：{guide}

按该策略提出一个新问题。记住引用铁律：evidence 必须逐字来自上面的原文片段。
只输出 JSON。"""


def load_answer(nodes_dir: Path, aid: str) -> dict:
    return json.loads((nodes_dir / "nodes" / f"{aid}.debug.json").read_text(encoding="utf-8"))


def pick_thesis(payload: dict) -> dict:
    for n in payload["nodes"]:
        if n["role"] == "thesis":
            return n
    return payload["nodes"][0]


def ask(question, pack_a, pack_b, name):
    s = STRATEGIES[name]
    msg = [
        {"role": "system", "content": SYS},
        {"role": "user", "content": USER_TPL.format(
            question=question,
            pack_a=render_pack(pack_a, "回答一"),
            pack_b=render_pack(pack_b, "回答二"),
            name=name, axis=s["axis"], desc=s["desc"], guide=s["guide"],
        )},
    ]
    raw = call_llm_resilient(msg, verbose=True)
    return parse_json(raw) or {}, msg[1]["content"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes", required=True)
    ap.add_argument("--sample", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pairs", nargs="+", required=True)
    ap.add_argument("--node-mode", default="thesis", choices=["thesis"])
    args = ap.parse_args()

    nd, out = Path(args.nodes), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    smp = {it["answer_id"]: it for it in json.loads(Path(args.sample).read_text(encoding="utf-8"))}

    rows = []
    for pair in args.pairs:
        ida, idb = pair.split(":")
        pa, pb = load_answer(nd, ida), load_answer(nd, idb)
        na, nb = pick_thesis(pa), pick_thesis(pb)
        srcs = {ida: smp[ida]["content"], idb: smp[idb]["content"]}

        cpa = build_context_pack(na, srcs[ida], pa["groups"],
                                 author=smp[ida].get("author", ""), all_nodes=pa["nodes"])
        cpb = build_context_pack(nb, srcs[idb], pb["groups"],
                                 author=smp[idb].get("author", ""), all_nodes=pb["nodes"])

        for i, name in enumerate(STRATEGIES, 1):
            print(f"  [{i}/{len(STRATEGIES)}] {name}  {ida}×{idb}", flush=True)
            try:
                res, prompt_text = ask(pa["question"], cpa, cpb, name)
            except Exception as e:
                rows.append({"pair": pair, "strategy": name, "passed": False,
                             "reason": f"调用失败: {e}", "raw": None})
                continue

            ok, enriched, reason = validate_question(res, srcs)
            rows.append({
                "pair": pair, "strategy": name, "axis": STRATEGIES[name]["axis"],
                "passed": ok, "reason": reason,
                "question": res.get("question"),
                "evidence": res.get("evidence"),
                "evidence_located": enriched.get("evidence_located"),
                "why": res.get("why"),
                "who_can_answer": res.get("who_can_answer"),
                "raw": res,
                "_prompt": prompt_text,
            })
            (out / "提问结果.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
            time.sleep(1.0)

    # 上下文包留存，供报告引用
    print(f"\n完成，写入 {out}")
    ok = sum(1 for r in rows if r.get("passed"))
    print(f"通过 {ok}/{len(rows)}")


if __name__ == "__main__":
    main()
