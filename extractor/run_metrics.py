# -*- coding: utf-8 -*-
"""实测指标：直接对应 Q1-Q4 四个待定问题。

用法：
    python metrics.py --outdir out
    python metrics.py --outdir out --pair a1 a2      # 额外做 Q3 的 thesis 对齐检查
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

BAR = "-" * 62


def load(outdir: Path):
    payloads = {}
    for p in sorted((outdir / "nodes").glob("*.debug.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        payloads[d["answer_id"]] = d
    reports = json.loads((outdir / "report.json").read_text(encoding="utf-8"))
    return payloads, {r["answer_id"]: r for r in reports}


def q1_type(payloads):
    """Q1：type 分布。真正该盯的是「非 claim 里有多少其实能对撞」。"""
    print(BAR)
    print("Q1  type 四类是否够用")
    dist, total = {}, 0
    for d in payloads.values():
        for n in d["nodes"]:
            dist[n["type"]] = dist.get(n["type"], 0) + 1
            total += 1
    for t, c in sorted(dist.items(), key=lambda x: -x[1]):
        print(f"    {t:<11} {c:>3}  {c / total:.0%}")
    claim_rate = dist.get("claim", 0) / total if total else 0
    print(f"\n    claim 占比 {claim_rate:.0%}  （v1 只实现 claim×claim，这就是碰撞池大小）")
    if claim_rate < 0.35:
        print("    [!] claim 偏少，碰撞池可能不够撑演示，检查是否把主张误判成了 fact")
    print("\n    人工复核项：把下面非 claim 的节点逐条看一遍，")
    print("    问「它能不能被另一篇的主张正面反对」，能 → 就是一次 claim 召回丢失。")
    for d in payloads.values():
        for n in d["nodes"]:
            if n["type"] != "claim":
                print(f"      [{n['type']:<10}] {n['claim_text']}")


def q2_scope(payloads):
    """Q2：scope 空值率。>70% 则 验真/划界 失去输入。"""
    print(BAR)
    print("Q2  scope 空值率")
    total = filled = 0
    samples = []
    for d in payloads.values():
        for n in d["nodes"]:
            total += 1
            if n.get("scope"):
                filled += 1
                samples.append(f"{n['scope']}  ←  {n['claim_text']}")
    empty = 1 - (filled / total if total else 0)
    print(f"    空值率 {empty:.0%}  ({total - filled}/{total})")
    if empty > 0.70:
        print("    [!] 超过 70% 阈值：验真/划界 缺输入。")
        print("        但先别急着改 prompt 逼模型填——按共识，空值本身要在画布上用虚线边框呈现。")
        print("        只有当『原文明确写了条件却没被抽出来』时才算 prompt 缺陷。")
    else:
        print("    通过阈值。已填样本：")
        for s in samples[:8]:
            print(f"      {s}")


def q3_thesis(payloads, pair):
    """Q3：thesis 归纳维度是否统一 —— 最关键。"""
    print(BAR)
    print("Q3  thesis 对齐度（决定金牌演示能否成立）")
    for d in payloads.values():
        th = next((n for n in d["nodes"] if n["role"] == "thesis"), None)
        if not th:
            continue
        print(f"    [{d['answer_id']}] stance={th.get('question_stance')}  grounded={th['grounded']}")
        print(f"           {th['claim_text']}")
    if not pair:
        return
    a, b = pair
    ta = next((n for n in payloads.get(a, {}).get("nodes", []) if n["role"] == "thesis"), None)
    tb = next((n for n in payloads.get(b, {}).get("nodes", []) if n["role"] == "thesis"), None)
    if not (ta and tb):
        print(f"    [!] {a} 或 {b} 缺少 thesis，无法配对")
        return
    sa, sb = ta.get("question_stance"), tb.get("question_stance")
    print(f"\n    配对 {a} × {b}：stance {sa} × {sb}")

    # 重要：动作由 type 决定，不由 stance 决定。
    # 两个 thesis 的 type 恒为 claim，所以按 2.5 配对表只能是 claim×claim，
    # 可用动作只有【交锋】和【合流】两个。
    # stance 的作用是给这两个动作排「张力优先级」，不派生任何新动作。
    # （曾经这里把 depends 组合判成「划界」，那是 claim×experience 行的动作，属越界，已修正。）
    ta_type, tb_type = ta.get("type"), tb.get("type")
    if ta_type == "claim" and tb_type == "claim":
        pair_kind = "claim × claim → 可用动作：交锋 / 合流"
    else:
        pair_kind = f"{ta_type} × {tb_type} → v1 暂不支持，显示「暂不支持」"
    print(f"    类型配对：{pair_kind}")

    tension = {
        ("yes", "no"): ("交锋", "★★★ 立场正面对立，张力最强 —— 金牌演示路径"),
        ("no", "yes"): ("交锋", "★★★ 立场正面对立，张力最强 —— 金牌演示路径"),
        ("yes", "depends"): ("交锋", "★★  一方无条件、一方有条件，分歧点在前提"),
        ("depends", "yes"): ("交锋", "★★  一方无条件、一方有条件，分歧点在前提"),
        ("no", "depends"): ("交锋", "★★  一方无条件、一方有条件，分歧点在前提"),
        ("depends", "no"): ("交锋", "★★  一方无条件、一方有条件，分歧点在前提"),
        ("yes", "yes"): ("合流", "★   同向，交锋张力弱，建议改用合流找隐藏共识"),
        ("no", "no"): ("合流", "★   同向，交锋张力弱，建议改用合流找隐藏共识"),
        ("depends", "depends"): ("合流", "★   双方都有条件，合流时可对比各自前提"),
    }.get((sa, sb))

    if sa == "reframe" or sb == "reframe":
        print("    张力判定：有一方重构了问题，两个 thesis 不在同一维度")
        print("              —— 这正是 Q3 担心的情况，应提示用户换节点而非硬碰")
    elif tension:
        act, desc = tension
        print(f"    推荐动作：{act}    张力：{desc}")
    else:
        print("    张力判定：stance 组合异常，需人工查看")


def q4_collidable(payloads, reports):
    """Q4：可碰性达标率 + 过滤器实际拦了什么。"""
    print(BAR)
    print("Q4  节点可碰性")
    for aid, d in payloads.items():
        nodes = d["nodes"]
        claims = [n for n in nodes if n["type"] == "claim"]
        rep = reports.get(aid, {})
        raw = rep.get("stats", {}).get("raw_node_count", len(nodes))
        print(f"    [{aid}] 模型给 {raw} 条 → 留下 {len(nodes)} 条 → 其中 claim {len(claims)} 条")
        no_counter = [n for n in nodes if not n.get("_counter")]
        if no_counter:
            print(f"          [!] {len(no_counter)} 条没有 _counter，说明反对测试没被执行")
        for n in nodes:
            if n.get("_counter"):
                print(f"          · {n['claim_text']}")
                print(f"            反对：{n['_counter']}")

    print("\n    quote 定位与丢弃情况：")
    for aid, r in reports.items():
        s = r.get("stats", {})
        print(f"    [{aid}] 匹配方式 {s.get('quote_match')}  丢弃 {s.get('dropped_count')} 条")
        for d_ in r.get("dropped", []):
            print(f"          丢弃({d_['reason']}): {d_['detail']}")
        for f_ in r.get("fixed", []):
            print(f"          修复({f_['reason']}): {f_['detail']}")


def coverage(payloads, reports):
    print(BAR)
    print("附加  group 覆盖度与空 group")
    for aid, r in reports.items():
        s = r.get("stats", {})
        print(f"    [{aid}] group {s.get('group_count')} 个，空 group {s.get('empty_group_count')} 个，"
              f"start_quote 可定位率 {s.get('group_grounded_rate')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--pair", nargs=2, default=None)
    args = ap.parse_args()
    payloads, reports = load(Path(args.outdir))
    if not payloads:
        print("没有找到抽取结果，先跑 extract.py")
        return
    q1_type(payloads)
    q2_scope(payloads)
    q3_thesis(payloads, args.pair)
    q4_collidable(payloads, reports)
    coverage(payloads, reports)
    print(BAR)


if __name__ == "__main__":
    main()
