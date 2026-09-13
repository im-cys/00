# -*- coding: utf-8 -*-
"""schema 校验 + 兜底修复。

原则：**绝不因为单个字段脏就整篇失败**。每一条不合规都尽量降级处理，
只有「连 thesis 都补不出来」这一种情况才算整篇失败。
所有降级动作都记进 report，用于 prompt 迭代。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from quote_locator import locate_quote

TYPES = ("claim", "fact", "experience", "method")
POLARITIES = ("positive", "negative")
ROLES = ("thesis", "point")

MAX_CLAIM_LEN = 40
MAX_SCOPE_LEN = 20
MAX_SUMMARY_LEN = 30
MAX_QUOTE_LEN = 80

# claim_text 开头的裸指代 / 转述框架，需要清洗或降级
_LEADING_DEIXIS = re.compile(r"^(这|那|它|他们|她们|其|该|此|上述|如前所述|前面提到的?)[，,、]?")
_REPORT_FRAME = re.compile(r"^(作者|答主|楼主|题主|他|她)(认为|提到|指出|表示|说)[，,：:]?")
# 注意：这里所有词条都必须是「不会作为普通词素出现在正常断言里」的形式。
# 踩过的坑：早期把「以上」直接放进来，结果「联系三位以上师兄」被误杀。
# 凡是这类高频子串，一律用 ^...$ 或前后锚点限定，不要裸放。
_META_PAT = re.compile(
    r"(谢邀|先说结论|以下分[一二三四五六七八九十\d]+点|利益相关|匿了|码字不易|"
    r"占个坑|未完待续|手机码字|个人拙见|一家之言"
    r"|^以上[。.，,]?$|^完[。.]?$|^全文完)"
)


@dataclass
class Report:
    answer_id: str
    ok: bool = True
    fatal: str | None = None
    dropped: list[dict] = field(default_factory=list)
    fixed: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def drop(self, reason: str, detail: Any):
        self.dropped.append({"reason": reason, "detail": detail})

    def fix(self, reason: str, detail: Any):
        self.fixed.append({"reason": reason, "detail": detail})


def _clip(s: str | None, n: int) -> str | None:
    if s is None:
        return None
    s = s.strip()
    return s[:n] if len(s) > n else s


def _clean_claim(text: str, rep: Report) -> str:
    t = (text or "").strip().strip("。.").strip()
    t2 = _REPORT_FRAME.sub("", t)
    if t2 != t:
        rep.fix("claim_text 去除转述框架", {"before": t, "after": t2})
        t = t2
    if len(t) > MAX_CLAIM_LEN:
        rep.fix("claim_text 超长截断", {"len": len(t), "text": t})
        t = t[:MAX_CLAIM_LEN]
    return t


def _normalize_groups(raw_groups, source: str, answer_id: str, rep: Report) -> list[dict]:
    groups = []
    for i, g in enumerate(raw_groups or []):
        if not isinstance(g, dict):
            continue
        title = _clip(str(g.get("title") or "").strip(), 12)
        if not title:
            rep.drop("group 缺少 title", g)
            continue
        order = g.get("order")
        order = order if isinstance(order, int) and order > 0 else i + 1
        sq = g.get("start_quote")
        loc = locate_quote(source, sq) if isinstance(sq, str) else None
        groups.append({
            "answer_id": answer_id,
            "group_id": "",           # 排序后统一编号
            "order": order,
            "title": title,
            "summary": _clip(g.get("summary"), MAX_SUMMARY_LEN) or "",
            "start_offset": loc.start if loc else None,
        })

    if not groups:
        rep.fix("无有效 group，兜底生成单一 group", None)
        groups = [{
            "answer_id": answer_id, "group_id": "", "order": 1,
            "title": "全文", "summary": "", "start_offset": 0,
        }]

    # 有 start_offset 的按原文位置排，没有的按模型 order 排，保证 order 单调
    groups.sort(key=lambda x: (x["start_offset"] if x["start_offset"] is not None else 10**9, x["order"]))
    for i, g in enumerate(groups, 1):
        g["order"] = i
        g["group_id"] = f"g{i}"

    # 覆盖度自检：相邻 group 起点之间的空洞
    known = [g for g in groups if g["start_offset"] is not None]
    holes = []
    if known:
        if known[0]["start_offset"] > len(source) * 0.25:
            holes.append({"where": "开头", "gap": known[0]["start_offset"]})
        for a, b in zip(known, known[1:]):
            gap = b["start_offset"] - a["start_offset"]
            if gap > max(600, len(source) * 0.5):
                holes.append({"where": f'{a["group_id"]}->{b["group_id"]}', "gap": gap})
    if holes:
        rep.fix("group 覆盖度存在空洞", holes)
    rep.stats["group_grounded_rate"] = round(len(known) / len(groups), 3)
    return groups


def _infer_type(claim: str, quote: str | None) -> str:
    """type 缺失/非法时的规则兜底，对应 prompt 里的三个二元问题。"""
    txt = f"{claim} {quote or ''}"
    if re.search(r"(建议|应该先|可以先|不妨|请务必|一定要|第一步|做法是|方法是|要记得)", txt):
        return "method"
    if re.search(r"(我|我们|我的|我朋友|我导师|我们实验室|我当年|我当时)", txt):
        return "experience"
    if re.search(r"(\d+(年|个月|%|％|人|篇)|平均|数据显示|统计|根据.{0,6}报告)", txt):
        return "fact"
    return "claim"


def _infer_polarity(claim: str) -> str:
    if re.search(r"(不|别|无法|难以|没有|风险|失败|劝退|不要|未必|弊|代价|坑)", claim):
        return "negative"
    return "positive"


def normalize(raw: dict, source: str, answer_id: str, question: str = "") -> tuple[dict, Report]:
    """把模型原始输出规整为最终 schema。返回 (payload, report)。"""
    rep = Report(answer_id=answer_id)
    if not isinstance(raw, dict):
        rep.ok, rep.fatal = False, "模型输出不是 JSON 对象"
        return {}, rep

    groups = _normalize_groups(raw.get("groups"), source, answer_id, rep)
    order2gid = {g["order"]: g["group_id"] for g in groups}
    default_gid = groups[0]["group_id"]

    raw_nodes = raw.get("nodes") or []
    if not isinstance(raw_nodes, list):
        raw_nodes = []
    rep.stats["raw_node_count"] = len(raw_nodes)

    nodes, thesis_candidates = [], []
    counters, scope_filled, quote_methods = 0, 0, []

    for n in raw_nodes:
        if not isinstance(n, dict):
            continue
        claim = _clean_claim(n.get("claim_text", ""), rep)
        if not claim:
            rep.drop("claim_text 为空", n)
            continue
        if _META_PAT.search(claim):
            rep.drop("claim_text 命中元话语", claim)
            continue
        if _LEADING_DEIXIS.match(claim):
            # 裸指代开头 = 不独立可读，thesis 不能丢所以只记录，point 直接丢
            if n.get("role") != "thesis":
                rep.drop("claim_text 以指代词开头，不独立可读", claim)
                continue
            rep.fix("thesis 含指代词开头，保留但需人工留意", claim)

        role = n.get("role") if n.get("role") in ROLES else "point"

        # ---- quote 回原文定位 ----
        raw_quote = n.get("quote")
        loc = locate_quote(source, raw_quote) if isinstance(raw_quote, str) else None
        if loc is None:
            if role == "thesis":
                quote, offset, grounded = None, None, False
                rep.fix("thesis quote 无法定位，降级为 grounded=False", raw_quote)
            else:
                rep.drop("quote 无法在原文定位（疑似幻觉）", {"claim": claim, "quote": raw_quote})
                continue
        else:
            quote = _clip(loc.text, MAX_QUOTE_LEN)
            offset, grounded = loc.start, True
            quote_methods.append(loc.method)

        ntype = n.get("type") if n.get("type") in TYPES else None
        if ntype is None:
            ntype = _infer_type(claim, quote)
            rep.fix("type 非法，规则兜底", {"claim": claim, "type": ntype})
        polarity = n.get("polarity") if n.get("polarity") in POLARITIES else None
        if polarity is None:
            polarity = _infer_polarity(claim)
            rep.fix("polarity 非法，规则兜底", {"claim": claim, "polarity": polarity})

        scope = n.get("scope")
        scope = _clip(scope, MAX_SCOPE_LEN) if isinstance(scope, str) and scope.strip() else None
        if scope:
            scope_filled += 1

        gid = order2gid.get(n.get("group_order"), default_gid)
        counter = n.get("_counter")
        if isinstance(counter, str) and counter.strip():
            counters += 1

        node = {
            "id": "",
            "answer_id": answer_id,
            "group_id": gid,
            "role": role,
            "claim_text": claim,
            "type": ntype,
            "polarity": polarity,
            "scope": scope,
            "quote": quote,
            "char_offset": offset,
            "grounded": grounded,
            "derived_from": [],            # 为碰撞产物预留，抽取阶段恒为空
            "_counter": counter if isinstance(counter, str) else None,
        }
        if role == "thesis":
            thesis_candidates.append(node)
        else:
            nodes.append(node)

    # ---- thesis 唯一性 ----
    if not thesis_candidates:
        # 兜底：把最长的 claim 型 point 提升为 thesis，而不是整篇失败
        promo = next((x for x in nodes if x["type"] == "claim"), None) or (nodes[0] if nodes else None)
        if promo is None:
            rep.ok, rep.fatal = False, "既无 thesis 也无可用 point，抽取失败"
            return {}, rep
        promo["role"] = "thesis"
        nodes.remove(promo)
        thesis_candidates = [promo]
        rep.fix("缺少 thesis，提升一个 point 兜底", promo["claim_text"])
    elif len(thesis_candidates) > 1:
        extra = thesis_candidates[1:]
        for e in extra:
            e["role"] = "point"
        nodes = extra + nodes
        rep.fix("thesis 多于 1 个，其余降级为 point", [e["claim_text"] for e in extra])

    thesis = thesis_candidates[0]
    gorder = {g["group_id"]: g["order"] for g in groups}
    nodes.sort(key=lambda x: (gorder.get(x["group_id"], 99), x["char_offset"] if x["char_offset"] is not None else 10**9))
    all_nodes = [thesis] + nodes
    for i, nd in enumerate(all_nodes, 1):
        nd["id"] = f"{answer_id}_n{i}"

    total = len(all_nodes)
    rep.stats.update({
        "group_count": len(groups),
        "node_count": total,
        "empty_group_count": sum(1 for g in groups if not any(n["group_id"] == g["group_id"] for n in all_nodes)),
        "scope_empty_rate": round(1 - scope_filled / total, 3) if total else 1.0,
        "counter_rate": round(counters / total, 3) if total else 0.0,
        "type_dist": {t: sum(1 for n in all_nodes if n["type"] == t) for t in TYPES},
        "quote_match": {m: quote_methods.count(m) for m in ("exact", "normalized", "fuzzy")},
        "thesis_grounded": thesis["grounded"],
        "dropped_count": len(rep.dropped),
    })

    payload = {
        "answer_id": answer_id,
        "question": question,
        "groups": groups,
        "nodes": all_nodes,
    }
    return payload, rep
