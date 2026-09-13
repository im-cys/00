# -*- coding: utf-8 -*-
"""上下文包：把一个 node 还原回原文现场。

二审新增。**零 LLM 调用，纯本地拼装。**

设计依据（实测数据）：
    claim_text 含数字率 4.0%，quote 含数字率 10.7%（2.7 倍）。
    具体信息从未丢失，只是归一化改写把它洗出了 claim_text，
    而提问层只拿到了 claim_text —— 这是管道问题，不是素材问题。

因此本模块不抽新东西，只把已有的 quote / group / 原文窗口传下去。
"""

from __future__ import annotations

import re

# 句子边界。用于窗口吸附，避免切出半句话。
_SENT_END = "。！？!?\n；;"

# 条件从句引导词。用于 condition_hints 扫描。
# 二审发现：模型对「A. 如果你找一份稳定的工作」这类**列表分支型条件**
# 系统性漏抽（q6_a9 原文 3 处「如果」，scope 全为 None）。
# 根因不是 prompt 措辞，而是这类条件在原文中距离 quote 较远、
# 且属于「分支枚举」而非「断言的定语」，模型不认为它是该断言的 scope。
# 对策：在上下文包层面用规则兜底扫描，把条件线索显式交给提问层，
# 不依赖模型在抽取阶段填对 scope。
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
    """把单个 node 还原为 ContextPack。

    参数
        node      : 抽取产出的 node dict
        source    : 该 answer 的清洗后原文（必须与抽取时同一份，否则 offset 错位）
        groups    : 该 answer 的 groups 列表
        all_nodes : 该 answer 的全部 node，用于取同 group 兄弟节点
    """
    gid = node.get("group_id")
    grp = next((g for g in (groups or []) if g.get("group_id") == gid), None)

    quote = node.get("quote") or ""
    off = node.get("char_offset")

    # ---- 原文窗口 ----
    if off is not None:
        ws = _snap_start(source, max(0, off - back))
        we = _snap_end(source, min(len(source), off + len(quote) + forward))
    elif grp is not None and grp.get("start_offset") is not None:
        # thesis quote 定位失败（grounded=False）时退化为 group 起始 500 字
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
        ct = n.get("claim_text")
        if ct:
            sibs.append(ct)
        if len(sibs) >= siblings_limit:
            break

    # ---- 条件线索规则兜底 ----
    hints = []
    for m in _COND_RE.finditer(window):
        t = m.group(0).strip()
        if t and t not in hints:
            hints.append(t)
    hints = hints[:5]

    return {
        "node_id": node.get("id"),
        "answer_id": node.get("answer_id"),
        "author": author,
        "claim_text": node.get("claim_text"),
        "type": node.get("type"),
        "polarity": node.get("polarity"),
        "scope": node.get("scope"),
        "quote": quote or None,
        "char_offset": off,
        "grounded": node.get("grounded"),
        "group": {
            "group_id": gid,
            "title": (grp or {}).get("title"),
            "summary": (grp or {}).get("summary"),
        },
        "siblings": sibs,
        "context_window": {"start": ws, "end": we, "text": window},
        "condition_hints": hints,
        "_counter": node.get("_counter"),
    }


def render_pack(pack: dict, label: str) -> str:
    """把 ContextPack 渲染成喂给模型的文本块。"""
    g = pack.get("group") or {}
    lines = [
        f"【{label}】作者：{pack.get('author') or '匿名用户'}（{pack.get('answer_id')}）",
        f"核心断言：{pack.get('claim_text')}",
        f"断言类型：{pack.get('type')} / {pack.get('polarity')}",
    ]
    if pack.get("scope"):
        lines.append(f"作者声明的适用范围：{pack['scope']}")
    if g.get("title"):
        lines.append(f"该断言所在段落：{g.get('title')} —— {g.get('summary') or ''}")
    if pack.get("quote"):
        lines.append(f"原文依据（逐字）：「{pack['quote']}」")
    if pack.get("siblings"):
        lines.append("同段其他论点：" + "；".join(pack["siblings"]))
    if pack.get("condition_hints"):
        lines.append("原文中出现的限定条件：" + " / ".join(pack["condition_hints"]))
    lines.append("原文片段（这是你唯一可引用的事实来源）：")
    lines.append((pack.get("context_window") or {}).get("text", ""))
    return "\n".join(lines)
