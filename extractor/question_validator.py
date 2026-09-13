# -*- coding: utf-8 -*-
"""提问产物的 evidence 回查闸门。

二审新增。**零 LLM 调用。直接复用 quote_locator.locate_quote，不写新算法。**

背景（实测证据）：
    一审 7 条提问产物中，「35岁」「转行」「被AI替代」等最抓眼球的具体元素，
    在 401 个节点和 q5 原文中出现次数均为 0 —— 是模型凭常识补写的社会情绪。
    抽取层的 quote 回查闸门（丢弃率 2.4%，有效）在提问层完全没有接上。

本模块把该闸门平移到提问层，阈值 0.82 与抽取层一致。

两道关卡：
    关卡一 evidence 定位：每条 evidence 必须能在两篇原文之一中定位，否则整条问题丢弃。
    关卡二 具体元素扫描：问题正文中的数字/年龄/年限，必须在原文或已验证 evidence 中有出处。
        （防止模型引一句无关原文充数，却在问题里夹带私货。）
"""

from __future__ import annotations

import re

from quote_locator import locate_quote

# 具体元素：数字串、年龄、年限、百分比、倍数
_NUM_TOKEN = re.compile(r"\d+(?:\.\d+)?\s*(?:岁|年|个月|%|％|倍|万|亿|人|篇|次|届)?")

# 高风险社会情绪词。这些词煽动性强但极易无中生有，单独强校验。
_RISK_WORDS = ["转行", "裁员", "被裁", "内卷", "躺平", "焦虑", "中年危机",
               "被AI替代", "被取代", "失业", "35岁"]

# 停用：这些数字型 token 属于通用表达，不要求原文出处
_NUM_WHITELIST = {"一", "二", "三", "1", "2", "3"}


def _norm_for_contains(s: str) -> str:
    """用于「包含」判断的宽松归一化：去空白、统一大小写。"""
    return re.sub(r"\s+", "", s or "").lower()


def validate_question(
    result: dict,
    sources: dict[str, str],
    threshold: float = 0.82,
    strict_tokens: bool = True,
) -> tuple[bool, dict, str]:
    """校验一条提问产物。

    参数
        result  : {"question","evidence":[...],"why","who_can_answer"}
        sources : {answer_id: 清洗后原文}
        strict_tokens : 关卡二是否硬拦截。False 时降级为 warnings（回退方案）。

    返回
        (passed, enriched, reason)
    """
    enriched = dict(result or {})
    enriched["evidence_located"] = []
    enriched["warnings"] = []

    q = (result or {}).get("question")

    # ---- 关卡零：基本形态 ----
    if not q or not isinstance(q, str) or not q.strip():
        return False, enriched, "无有效问句（question 为空）"
    q = q.strip()
    if not q.endswith(("？", "?")):
        return False, enriched, "产物不是问句（未以问号结尾）"

    ev = (result or {}).get("evidence")
    if not isinstance(ev, list) or not [e for e in ev if isinstance(e, str) and e.strip()]:
        return False, enriched, "未提供引用凭据（evidence 为空）"

    # ---- 关卡一：evidence 逐条回原文定位 ----
    located = []
    for e in ev:
        if not isinstance(e, str) or not e.strip():
            continue
        hit = None
        for aid, src in sources.items():
            loc = locate_quote(src, e, threshold=threshold)
            if loc is not None:
                hit = {
                    "text": loc.text,
                    "answer_id": aid,
                    "start": loc.start,
                    "end": loc.end,
                    "method": loc.method,
                    "score": loc.score,
                }
                break
        if hit is None:
            return False, enriched, f"evidence 无法在原文定位（疑似幻觉）：{e[:40]}"
        located.append(hit)

    enriched["evidence_located"] = located

    # ---- 关卡二：问题正文中的具体元素必须有出处 ----
    # 可核对的语料 = 两篇原文全文 + 已验证 evidence 原文
    corpus = _norm_for_contains(
        "".join(sources.values()) + "".join(h["text"] for h in located)
    )

    unsourced = []

    for m in _NUM_TOKEN.finditer(q):
        tok = m.group(0).strip()
        digits = re.sub(r"\D", "", tok)
        if not digits or digits in _NUM_WHITELIST:
            continue
        if _norm_for_contains(tok) in corpus or digits in corpus:
            continue
        unsourced.append(tok)

    for w in _RISK_WORDS:
        if w in q and _norm_for_contains(w) not in corpus:
            unsourced.append(w)

    if unsourced:
        uniq = list(dict.fromkeys(unsourced))
        reason = f"问题含无出处的具体元素：{uniq}"
        if strict_tokens:
            return False, enriched, reason
        enriched["warnings"].append(reason)

    return True, enriched, "通过"
