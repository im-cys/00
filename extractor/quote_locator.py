# -*- coding: utf-8 -*-
"""quote 回原文定位：三级匹配。

模型给的 quote 经常在标点、空白、省略号上偷偷失真，纯 str.find 失败率高。
这里做三级回退，并保证返回的 offset 一定是**原文**上的偏移，而不是归一化文本上的。

定位失败的处理策略（在 validate.py 中执行）：
  - role=point   -> 直接丢弃该节点（quote 是防幻觉凭据，对不上说明大概率是编的）
  - role=thesis  -> 允许 quote=None + grounded=False，因为 thesis 是全文归纳，
                    原文可能根本不存在对应的一句话，而 thesis 又不能丢。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

# 会被模型顺手改掉或吞掉的字符，归一化时整体剔除
_DROP_CHARS = set(" \t\r\n\u3000\u200b\ufeff")

# 常见等价替换：中英标点、破折号、省略号变体
_EQUIV = {
    "，": ",", "。": ".", "；": ";", "：": ":", "？": "?", "！": "!",
    "（": "(", "）": ")", "【": "[", "】": "]", "《": "<", "》": ">",
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "—": "-", "–": "-", "－": "-", "～": "~",
    "…": ".", "⋯": ".",
}

_TRAILING_ELLIPSIS = re.compile(r"[.。…⋯\s]+$")


@dataclass
class Located:
    start: int          # 原文字符偏移
    end: int            # 原文字符偏移（不含）
    text: str           # 原文上的真实文本（用它覆盖模型给的 quote）
    method: str         # exact | normalized | fuzzy
    score: float        # 1.0 表示精确


def _norm_char(ch: str) -> str:
    ch = unicodedata.normalize("NFKC", ch)
    return _EQUIV.get(ch, ch)


def _normalize_with_map(text: str):
    """返回 (归一化文本, 归一化下标 -> 原文下标 的映射)。"""
    buf = []
    index_map = []
    for i, ch in enumerate(text):
        if ch in _DROP_CHARS:
            continue
        nc = _norm_char(ch)
        if not nc:
            continue
        for c in nc:
            buf.append(c.lower())
            index_map.append(i)
    return "".join(buf), index_map


def _fuzzy_search(norm_src: str, norm_q: str, threshold: float):
    """滑窗相似度匹配。窗口长度在 quote 长度附近浮动，取最高分。"""
    n, m = len(norm_src), len(norm_q)
    if m == 0 or n < m // 2:
        return None
    best = (0.0, -1, -1)
    # 步长随文本长度自适应，控制在几千次比较以内
    step = max(1, m // 6)
    for win in (m, int(m * 1.15) + 1, max(1, int(m * 0.85))):
        if win > n:
            continue
        for s in range(0, n - win + 1, step):
            seg = norm_src[s:s + win]
            # 先用首尾字符快速过滤，避免全量 SequenceMatcher
            if seg[0] != norm_q[0] and seg[-1] != norm_q[-1]:
                continue
            score = SequenceMatcher(None, seg, norm_q).ratio()
            if score > best[0]:
                best = (score, s, s + win)
    if best[0] >= threshold:
        return best
    return None


def locate_quote(source: str, quote: str, threshold: float = 0.82) -> Located | None:
    """在 source 中定位 quote，返回原文偏移。找不到返回 None。"""
    if not quote or not quote.strip():
        return None
    q = quote.strip()

    # ---- 一级：精确匹配 ----
    idx = source.find(q)
    if idx >= 0:
        return Located(idx, idx + len(q), q, "exact", 1.0)

    # 模型爱在句尾加省略号，去掉再试一次精确
    q_trim = _TRAILING_ELLIPSIS.sub("", q)
    if q_trim and q_trim != q:
        idx = source.find(q_trim)
        if idx >= 0:
            return Located(idx, idx + len(q_trim), q_trim, "exact", 1.0)

    # ---- 二级：归一化后匹配 ----
    norm_src, imap = _normalize_with_map(source)
    norm_q, _ = _normalize_with_map(q_trim or q)
    if not norm_q:
        return None
    pos = norm_src.find(norm_q)
    if pos >= 0:
        s = imap[pos]
        e = imap[pos + len(norm_q) - 1] + 1
        return Located(s, e, source[s:e], "normalized", 1.0)

    # ---- 三级：滑窗相似度 ----
    hit = _fuzzy_search(norm_src, norm_q, threshold)
    if hit:
        score, ns, ne = hit
        s = imap[ns]
        e = imap[min(ne, len(imap)) - 1] + 1
        return Located(s, e, source[s:e], "fuzzy", round(score, 3))

    return None
