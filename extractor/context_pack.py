# -*- coding: utf-8 -*-
"""上下文包：把一个 collision 节点还原回原文现场。

**零 LLM 调用，纯本地拼装。**

设计依据（实测数据）：
    statement 含数字率 4.0%，quote 含数字率 10.7%（2.7 倍）。
    具体信息从未丢失，只是归一化改写把它洗出了 statement，
    而提问层只拿到了 statement —— 这是管道问题，不是素材问题。

因此本模块不抽新东西，只把已有的结构化语义字段、quote、group 和原文窗口传下去。

v2.4 变化：渲染抽取阶段产出的 axis / stance / conditions / excludes。
旧版渲染的 _counter（模型虚构的反对意见）已删除——它凭空生成，质量不可控，
且在 strip_internal 之后实际取到的永远是 None，属于死字段。
"""

from __future__ import annotations

import re

# 句子边界。用于窗口吸附，避免切出半句话。
_SENT_END = "。！？!?\n；;"

# 条件从句引导词。用于 condition_hints 规则兜底扫描。
# 实测发现：模型对「A. 如果你找一份稳定的工作」这类**列表分支型条件**
# 系统性漏抽（q6_a9 原文 3 处「如果」，条件全为空）。
# 根因不是 prompt 措辞，而是这类条件在原文中距离 quote 较远、
# 且属于「分支枚举」而非「断言的定语」，模型不认为它属于该断言。
# 对策：在上下文包层面用规则兜底扫描，把条件线索显式交给提问层，
# 不依赖模型在抽取阶段填对结构化 conditions。
_COND_PATS = [
    r"如果[^。！？\n]{0,40}",
    r"假如[^。！？\n]{0,40}",
    r"只要[^。！？\n]{0,40}",
    r"除非[^。！？\n]{0,40}",
    r"前提是[^。！？\n]{0,40}",
    r"在[^。！？\n]{0,30}的?情况下",
    r"对[^。！？\n]{1,12}(?:而言|来说)",
    r"(?:大部分|多数情况下|绝大多数|至少|一般来说)[^。！？\n]{0,30}",
]
_COND_RE = re.compile("|".join(_COND_PATS))

_STANCE_TEXT = {
    "should": "主张应该这样做",
    "should_not": "主张不该这样做",
    "conditional": "视条件而定",
    "descriptive": "只描述现象，未主张该不该做",
}
_STRENGTH_TEXT = {
    "absolute": "绝对，不留例外",
    "conditional": "有条件成立",
    "tendency": "倾向性，留有余地",
}
_COND_LABEL = {"audience": "人群", "stage": "阶段", "premise": "前提"}


def _snap_start(source: str, pos: int) -> int:
    """向前吸附到最近的句首（上一个句末标点之后）。"""
    if pos <= 0:
        return 0
    for i in range(pos, max(-1, pos - 120), -1):
        if i > 0 and source[i - 1] in _SENT_END:
            return i
    return max(0, pos)


def _snap_end(source: str, pos: int) -> int:
    """向后吸附到最近的句尾（含句末标点）。"""
    n = len(source)
    if pos >= n:
        return n
    for i in range(pos, min(n, pos + 120)):
        if source[i] in _SENT_END:
            return i + 1
    return min(n, pos)


def build_context_pack(
    node: dict,
    source: str,
    groups: list[dict],
    author: str = "",
    siblings_limit: int = 3,
    all_nodes: list[dict] | None = None,
    back: int = 200,
    forward: int = 300,
) -> dict:
    """把单个 collision 节点还原为 ContextPack。

    参数
        node      : 抽取产出的节点 dict
        source    : 该 answer 的清洗后原文（必须与抽取时同一份，否则 offset 错位）
        groups    : 该 answer 的 groups 列表
        all_nodes : 该 answer 的全部节点，用于取同 group 兄弟节点
    """
    gid = node.get("group_id")
    grp = next((g for g in (groups or []) if g.get("group_id") == gid), None)

    statement = node.get("statement") or node.get("claim_text") or ""
    quote = node.get("quote") or ""
    off = node.get("char_offset")

    # ---- 原文窗口 ----
    if off is not None:
        ws = _snap_start(source, max(0, off - back))
        we = _snap_end(source, min(len(source), off + len(quote) + forward))
    elif grp is not None and grp.get("start_offset") is not None:
        # quote 定位失败时退化为 group 起始 500 字
        gs = grp["start_offset"]
        ws = _snap_start(source, gs)
        we = _snap_end(source, min(len(source), gs + 500))
    else:
        ws, we = 0, _snap_end(source, min(len(source), 500))

    window = source[ws:we]

    # ---- 同 group 兄弟节点 ----
    sibs = []
    for n in (all_nodes or []):
        if n is node or n.get("group_id") != gid:
            continue
        text = n.get("statement") or n.get("claim_text")
        if text:
            sibs.append(text)
        if len(sibs) >= siblings_limit:
            break

    # ---- 条件线索规则兜底 ----
    hints = []
    for m in _COND_RE.finditer(window):
        t = m.group(0).strip()
        if t and t not in hints:
            hints.append(t)

    conditions = node.get("conditions")
    if not isinstance(conditions, dict):
        conditions = {"audience": [], "stage": [], "premise": []}

    return {
        "node_id": node.get("id"),
        "answer_id": node.get("answer_id"),
        "author": author,
        "statement": statement,
        "axis": node.get("axis") or "",
        "stance": node.get("stance") or "",
        "conditions": conditions,
        "excludes": node.get("excludes") or [],
        "strength": node.get("strength"),
        "tradeoff": node.get("tradeoff"),
        "not_applicable": node.get("not_applicable"),
        "collision_role": node.get("collision_role"),
        "quote": quote or None,
        "char_offset": off,
        "group": {
            "group_id": gid,
            "title": (grp or {}).get("title"),
            "summary": (grp or {}).get("summary"),
        },
        "siblings": sibs,
        "context_window": {"start": ws, "end": we, "text": window},
        "condition_hints": hints[:5],
        "ancestor_path": node.get("ancestor_path") or [],
        "reason_summary": node.get("reason_summary"),
        "supports": node.get("supports") or [],
    }


def render_pack(pack: dict, label: str) -> str:
    """把 ContextPack 渲染成喂给模型的文本块。"""
    g = pack.get("group") or {}
    lines = [
        f"【{label}】作者：{pack.get('author') or '匿名用户'}（{pack.get('answer_id')}）",
        f"观点：{pack.get('statement')}",
    ]
    if pack.get("axis"):
        lines.append(f"这个观点在裁决的对象：{pack['axis']}")
    stance = pack.get("stance")
    if stance:
        lines.append(f"主张方向：{_STANCE_TEXT.get(stance, stance)}")
    if pack.get("strength"):
        lines.append(f"判断强度：{_STRENGTH_TEXT.get(pack['strength'], pack['strength'])}")

    conditions = pack.get("conditions") or {}
    stated = [
        f"{_COND_LABEL[key]}：{'、'.join(conditions.get(key) or [])}"
        for key in ("audience", "stage", "premise")
        if conditions.get(key)
    ]
    lines.append("作者声明的适用条件：" + ("；".join(stated) if stated else "原文未限定（普遍适用）"))

    if pack.get("excludes"):
        lines.append("作者明确排除或劝阻的做法：" + "；".join(pack["excludes"]))
    else:
        lines.append("作者没有在原文中明确排除任何替代做法")
    if pack.get("tradeoff"):
        lines.append(f"作者承认的代价：{pack['tradeoff']}")
    if pack.get("not_applicable"):
        lines.append(f"作者声明不适用的情形：{pack['not_applicable']}")

    if g.get("title"):
        lines.append(f"该观点所在段落：{g.get('title')} —— {g.get('summary') or ''}")
    if pack.get("ancestor_path"):
        labels = [item.get("text") for item in pack["ancestor_path"]
                  if isinstance(item, dict) and item.get("text")]
        if labels:
            lines.append("所在观点树路径：" + " → ".join(labels))
    if pack.get("reason_summary"):
        lines.append(f"作者的论证摘要：{pack['reason_summary']}")
    if pack.get("quote"):
        lines.append(f"原文依据（逐字）：「{pack['quote']}」")
    extra = [item for item in (pack.get("supports") or [])
             if item.get("quote") and item.get("quote") != pack.get("quote")]
    if extra:
        lines.append("其他逐字支撑：" + " / ".join(f"「{item['quote']}」" for item in extra[:3]))
    if pack.get("siblings"):
        lines.append("同段其他论点：" + "；".join(pack["siblings"]))
    if pack.get("condition_hints"):
        lines.append("原文附近出现的限定条件：" + " / ".join(pack["condition_hints"]))
    lines.append("原文片段（这是你唯一可引用的事实来源）：")
    lines.append((pack.get("context_window") or {}).get("text", ""))
    return "\n".join(lines)
