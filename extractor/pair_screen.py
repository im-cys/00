# -*- coding: utf-8 -*-
"""碰撞预检闸门：零 LLM 调用，排除明显无关或近乎重复的节点对。

设计原则（这是本模块存在的理由，改动前请先读）：

    差异量 ≠ 冲突性。两个观点可以处处不同却毫无冲突（一方只是另一方在更窄
    条件下的具体做法），也可以只差一个字就直接对立。因此本模块**不做综合
    分歧度打分**——那样会把「维度差异大但相容」的配对打成高分，恰好放大误判。

    产品中的“碰撞”不只等于正面对立。共同对象上的条件差异、视角互补和共识背后的
    未答问题也可能产生有价值的新问题。预检只负责拦截明显无关和近乎重复的组合，
    其余关系交给带原文证据的模型判定。

v3 放宽：上一版把“碰撞”限定成必须存在客观冲突信号，导致同一对象上的互补视角、
条件差异和描述/建议组合在进入模型前就被误杀。本版保留 axis 对齐与近重复拦截，
其余结构化差异只作为关系线索，由模型结合双方原文判断能否提出有价值的问题。
"""

from __future__ import annotations

import re

# 与 collision-core.js 的 stopGrams 保持一致：高频虚词二元组不计入共享词。
_STOP_GRAMS = {
    "因为", "所以", "我们", "他们", "一个", "这个", "那个", "可以", "不是", "就是",
    "非常", "其实", "已经", "如果", "但是", "而且", "这样", "那样", "的话", "时候",
    "东西", "方面", "情况", "自己", "没有", "还是", "什么", "怎么", "这些", "那些",
    "之后", "之前", "一样", "觉得", "认为", "应该", "需要", "真的", "很多", "一些",
    "出来", "起来", "下去", "而是", "只是", "因此", "以及", "或者", "然后", "当然",
    "其中", "是否", "要不", "不要", "还有", "对于", "关于", "能否", "该不",
}

# ---------------------------------------------------------------------------
# 量化阈值。收紧碰撞通过率时只调这里，不要在函数体内散落魔法数字。
# ---------------------------------------------------------------------------
# C1 争议对象对齐
AXIS_OVERLAP_MIN = 1        # 两侧 axis 都存在、措辞不同时，至少共享一个核心概念
AXIS_SEMANTIC_MIN = 2       # axis 未对齐时，完整观点共享概念的二次回退门槛
AXIS_FALLBACK_MIN = 3       # 任一侧 axis 缺失，退回用观点全句比对时的门槛
# C5 观点相似度（Jaccard）。超过上限视为两人在说同一件事，属共识而非分歧。
CLAIM_SIMILARITY_MAX = 0.54
# C4 同一 axis 下两个主张要被认定为「给出了不同答案」，相似度须低于此值。
# 略低于 CLAIM_SIMILARITY_MAX，留出一段中间带：那里两句话既不算近义重复、
# 也不足以证明分歧，必须靠更硬的信号（原文排除表述、主张方向相反）。
# 不要调得太低：中文短句共享句式框架（「我认为选专业该优先看…」）会抬高
# 相似度，阈值过严会把「同轴不同答案」这类真分歧误杀。
DIVERGENCE_SIMILARITY_MAX = 0.45
# axis 缺失退回全句比对时，要用「同轴异答」这个信号需要的共享二元组数。
# 高于 C1 的入门门槛：勉强达标的弱对齐不足以反推「分歧存在」，
# 那种情况必须靠更硬的信号（原文排除表述、主张方向相反）。
DIVERGENCE_FALLBACK_SHARED_MIN = 6
# 强冲突信号：由原文表述或结构化字段直接佐证，不依赖相似度推断。
# same_axis_divergent_claims 不在此列——它只说明「两句话措辞不同」，
# 而措辞不同既可能是对立，也可能是互补。因此它不足以让渲染层断言「这是冲突」，
# 命中它时仍要提示模型考虑互补、适用边界与共同盲点。
STRONG_CONFLICT_CODES = {"excludes_cross", "stance_opposed", "absolute_vs_conditional"}

# 主张方向两两相容性。值为 True 表示「有可能构成真冲突，放行给后续检查」。
#
# descriptive × should / should_not 一律为 False：一方只在描述现象，另一方在
# 主张该不该做，两者不在同一个裁决平面上，通常是互补细化而非冲突。
# descriptive × descriptive 保持 True：两个描述可以在归因或机制上互斥。
_STANCE_MATRIX = {
    ("should", "should"): True,             # 同一对象上主张不同做法，可能冲突
    ("should", "should_not"): True,         # 最典型的直接对立
    ("should", "conditional"): True,        # 无条件主张 vs 视条件而定
    ("should", "descriptive"): False,
    ("should_not", "should_not"): True,
    ("should_not", "conditional"): True,
    ("should_not", "descriptive"): False,
    ("conditional", "conditional"): True,   # 条件分歧的合法来源
    ("conditional", "descriptive"): False,
    ("descriptive", "descriptive"): True,   # 归因冲突 / 机制冲突
}

_PUNCT = re.compile(r"[，。、；：！？,.;:!?\"'“”‘’（）()【】\[\]…—\-～~\s]+")


def _squeeze(value) -> str:
    return _PUNCT.sub("", str(value or "")).lower()


def _text_of(node: dict) -> str:
    """节点正文。statement 是当前字段名，claim_text 保留给旧缓存。"""
    return str(node.get("statement") or node.get("claim_text") or "")


def _bigrams(text: str) -> set[str]:
    """中文二元组 + 英文单词。与前端 terms() 同构，保证两端判断一致。"""
    source = str(text or "").lower()
    found: set[str] = set()
    for word in re.findall(r"[a-z][a-z0-9+#._-]*", source):
        if len(word) > 1:
            found.add(word)
    for run in re.sub(r"[^\u3400-\u9fff]+", " ", source).split():
        for at in range(len(run) - 1):
            gram = run[at:at + 2]
            if gram not in _STOP_GRAMS:
                found.add(gram)
    return found


def _shared(left: set[str], right: set[str]) -> list[str]:
    return sorted(left & right)


def _jaccard(left: set[str], right: set[str]) -> float:
    """两段文本的词形相似度。用于区分「不同答案」和「同一答案的两种说法」。"""
    if not left or not right:
        return 0.0
    union = left | right
    return round(len(left & right) / len(union), 3) if union else 0.0


def _stance_of(node: dict) -> str:
    value = str(node.get("stance") or "").strip()
    return value if value in {"should", "should_not", "conditional", "descriptive"} else "conditional"


def _condition_items(node: dict) -> dict[str, list[str]]:
    raw = node.get("conditions") or {}
    if not isinstance(raw, dict):
        return {"audience": [], "stage": [], "premise": []}
    out = {}
    for key in ("audience", "stage", "premise"):
        value = raw.get(key)
        items = value if isinstance(value, list) else ([value] if isinstance(value, str) else [])
        out[key] = [str(item).strip() for item in items if str(item or "").strip()]
    return out


def _axis_alignment(node_a: dict, node_b: dict) -> tuple[str | None, dict]:
    """C1：两个节点是否在裁决同一件事，并给出对齐强度。

    返回 (level, detail)，level 取 exact / overlap / fallback / None。
    - exact    ：两侧 axis 逐字相同。抽取端按 knownAxes 对齐的主路径。
    - overlap  ：两侧 axis 都存在但措辞不同，共享二元组达到 AXIS_OVERLAP_MIN。
    - semantic ：axis 措辞没对齐，但完整观点仍共享至少两个有效概念。
    - fallback ：任一侧 axis 缺失，退回观点全句比对，门槛更高。
      这条路径本身就说明抽取质量不足，因此不允许它再单独支撑「强对齐」结论。
    """
    axis_a, axis_b = _squeeze(node_a.get("axis")), _squeeze(node_b.get("axis"))
    detail: dict = {"a": node_a.get("axis"), "b": node_b.get("axis")}
    if axis_a and axis_b:
        if axis_a == axis_b:
            detail.update(level="exact", shared=[], threshold=0)
            return "exact", detail
        shared = _shared(_bigrams(node_a.get("axis")), _bigrams(node_b.get("axis")))
        detail.update(level="overlap", shared=shared[:6],
                      shared_count=len(shared), threshold=AXIS_OVERLAP_MIN)
        if len(shared) >= AXIS_OVERLAP_MIN:
            return "overlap", detail
        claim_shared = _shared(_bigrams(_text_of(node_a)), _bigrams(_text_of(node_b)))
        detail.update(level="semantic", statement_shared=claim_shared[:6],
                      statement_shared_count=len(claim_shared),
                      statement_threshold=AXIS_SEMANTIC_MIN)
        return ("semantic" if len(claim_shared) >= AXIS_SEMANTIC_MIN else None), detail
    shared = _shared(_bigrams(_text_of(node_a)), _bigrams(_text_of(node_b)))
    detail.update(level="fallback", shared=shared[:6],
                  shared_count=len(shared), threshold=AXIS_FALLBACK_MIN,
                  note="至少一侧缺少 axis，已退回观点全句比对")
    return ("fallback" if len(shared) >= AXIS_FALLBACK_MIN else None), detail


def _conditions_overlap(node_a: dict, node_b: dict) -> tuple[bool, dict]:
    """C2：适用条件是否存在重叠区。

    空条件表示普遍适用，与任何条件都重叠。双方明确限定且没有交集时标记为条件差异，
    但不直接拒绝；同一对象在不同人群或阶段的差异本身可能引出适用边界问题。

    注意：模型经常漏填 conditions，所以这里不能反向把「都为空」当成分歧证据；
    这里只记录条件关系，最终由带原文证据的关系判定决定是否值得继续提问。
    """
    cond_a, cond_b = _condition_items(node_a), _condition_items(node_b)
    detail, exclusive, stated = {}, [], 0
    for key in ("audience", "stage", "premise"):
        left, right = cond_a[key], cond_b[key]
        if not left or not right:
            detail[key] = "universal"
            continue
        stated += 1
        grams_left = set().union(*(_bigrams(item) for item in left))
        grams_right = set().union(*(_bigrams(item) for item in right))
        shared = _shared(grams_left, grams_right)
        if shared:
            detail[key] = f"overlap:{','.join(shared[:4])}"
        else:
            detail[key] = "exclusive"
            exclusive.append(key)
    return not exclusive, {
        "per_key": detail, "exclusive_keys": exclusive, "both_stated_keys": stated,
    }


def _excludes_cross_hit(node_a: dict, node_b: dict) -> list[dict]:
    """一方的主张正好落在另一方明确排除的做法里。

    这是最可靠的真冲突证据——它由原文排除表述支撑，不是虚构的反对意见。
    """
    hits = []
    for owner, other, label in ((node_a, node_b, "a_excludes_b"), (node_b, node_a, "b_excludes_a")):
        excludes = owner.get("excludes")
        if not isinstance(excludes, list):
            continue
        claim_grams = _bigrams(_text_of(other))
        for item in excludes:
            text = str(item or "").strip()
            if not text:
                continue
            shared = _shared(_bigrams(text), claim_grams)
            if len(shared) >= 2:
                hits.append({"direction": label, "excluded": text[:24], "shared": shared[:4]})
    return hits


def _conflict_signals(node_a: dict, node_b: dict, axis_level: str,
                      axis_shared_count: int, similarity: float,
                      exclude_hits: list[dict]) -> list[dict]:
    """C4：收集客观可核的强分歧信号，作为后续模型判断的线索。

    没命中不代表没有有价值的关联；模型仍可基于互补、条件边界或共同前提提问。
    """
    signals: list[dict] = []
    stance_a, stance_b = _stance_of(node_a), _stance_of(node_b)
    stances = {stance_a, stance_b}

    if exclude_hits:
        signals.append({
            "code": "excludes_cross",
            "detail": "一方的主张落在另一方原文明确排除的做法里",
        })
    if stances == {"should", "should_not"}:
        signals.append({
            "code": "stance_opposed",
            "detail": "一方主张该做、另一方主张不该做",
        })
    # 同一争议对象下给出了明显不同的答案：对齐可靠，而两句话的说法差异大。
    #
    # 「共享词多 + 相似度中低」正是真分歧的特征：两人在谈同一批概念（共享词多），
    # 但给出的说法不同（相似度低）。反过来「各说一面」的配对共享词很少，
    # 在 C1 就被拦掉了，不会走到这里。
    #
    # axis 缺失退回全句比对时不能直接禁用这个信号（那会误杀真分歧），
    # 而是要求更强的对齐证据：共享词数须达到 DIVERGENCE_FALLBACK_SHARED_MIN，
    # 高于 C1 的入门门槛。勉强达标的弱对齐仍然只能靠更硬的信号。
    divergent = similarity <= DIVERGENCE_SIMILARITY_MAX
    if axis_level in {"exact", "overlap"}:
        alignment_ok = True
    else:
        alignment_ok = axis_shared_count >= DIVERGENCE_FALLBACK_SHARED_MIN
    if divergent and alignment_ok:
        signals.append({
            "code": "same_axis_divergent_claims",
            "detail": f"同一争议对象下两个主张说法差异明显（相似度 {similarity}）",
        })
    # 一方给绝对判断、另一方视条件而定：这是「元层 / 条件分歧」的客观形态。
    strengths = {str(node_a.get("strength") or ""), str(node_b.get("strength") or "")}
    if "absolute" in strengths and "conditional" in stances:
        signals.append({
            "code": "absolute_vs_conditional",
            "detail": "一方给出绝对判断，另一方认为要看条件",
        })
    return signals


def screen_pair(node_a: dict, node_b: dict) -> dict:
    """拦截明显无关或近乎重复的配对，其余交给模型做关系判定。

    返回 {"collidable": bool, "code": str, "reason": str, "signals": {...}}
    collidable=False 时调用方应直接返回 no_result，不消耗模型调用。

    闸门顺序：
      C1 争议对象对齐        axis_mismatch
      C5 观点不高度相似      claims_too_similar

    C2 条件差异、C3 描述/建议差异、C4 缺少强冲突信号现在只作为关系线索，
    不再一刀切拒绝；它们可能形成条件边界、互补解释或共同盲点问题。
    """
    signals: dict = {}

    # ---- C1 争议对象 ----
    axis_level, axis_detail = _axis_alignment(node_a, node_b)
    signals["axis"] = {**axis_detail, "aligned": bool(axis_level),
                       "exact": axis_level == "exact"}
    if not axis_level:
        return {
            "collidable": False, "code": "axis_mismatch",
            "reason": "这两个观点在裁决的不是同一件事，先换一组讨论同一个问题的观点。",
            "signals": signals,
        }

    # ---- C2 适用条件 ----
    cond_ok, cond_detail = _conditions_overlap(node_a, node_b)
    signals["conditions"] = cond_detail
    signals["conditions"]["relation_hint"] = (
        "different_conditions" if not cond_ok else "overlapping_conditions"
    )

    # ---- C3 主张方向 ----
    stance_a, stance_b = _stance_of(node_a), _stance_of(node_b)
    pair = tuple(sorted((stance_a, stance_b)))
    compatible = _STANCE_MATRIX.get(pair, _STANCE_MATRIX.get((pair[1], pair[0]), True))
    signals["stance"] = {"a": stance_a, "b": stance_b, "conflict_possible": compatible}
    if not compatible:
        signals["stance"]["relation_hint"] = "description_and_recommendation"

    # ---- C5 观点相似度：高度相似即共识，不是分歧 ----
    similarity = _jaccard(_bigrams(_text_of(node_a)), _bigrams(_text_of(node_b)))
    signals["similarity"] = {
        "value": similarity, "limit": CLAIM_SIMILARITY_MAX,
        "divergence_limit": DIVERGENCE_SIMILARITY_MAX,
    }
    if similarity > CLAIM_SIMILARITY_MAX:
        return {
            "collidable": False, "code": "claims_too_similar",
            "reason": f"这两个观点说的其实是同一件事（措辞相似度 {similarity}），"
                      "把它们碰在一起只会得到一个已经有共识的结论。",
            "signals": signals,
        }

    # ---- C4 分歧/关联信号：用于提示模型，不再作为硬拒绝条件 ----
    exclude_hits = _excludes_cross_hit(node_a, node_b)
    signals["excludes_cross_hit"] = exclude_hits
    signals["strength"] = {"a": node_a.get("strength"), "b": node_b.get("strength")}
    conflict = _conflict_signals(
        node_a, node_b, axis_level,
        int(axis_detail.get("shared_count") or 0), similarity, exclude_hits,
    )
    signals["conflict_signals"] = conflict
    # 与 render_screen 用同一套强弱口径：弱信号（仅靠相似度推断的「同轴异答」）
    # 不足以把配对定性为冲突，否则下游会按二选一来提问，丢掉互补类的价值。
    strong = [item for item in conflict if item.get("code") in STRONG_CONFLICT_CODES]
    signals["relation_basis"] = (
        "conflict" if strong else
        "different_conditions" if not cond_ok else
        "complementary_perspectives"
    )

    return {
        "collidable": True,
        "code": ("direct_conflict_candidate" if exclude_hits else
                 "candidate" if strong else "related_candidate"),
        "reason": "",
        "signals": signals,
    }


def render_screen(signals: dict) -> str:
    """把预检结果渲染成给模型看的客观事实，避免它重复判断已经算清的部分。"""
    lines = []
    axis = signals.get("axis") or {}
    if axis.get("exact"):
        lines.append(f"- 争议对象已对齐（两边登记为同一对象）：{axis.get('a')}")
    elif axis.get("level") == "overlap":
        lines.append(f"- 争议对象措辞不同但有重叠：A「{axis.get('a')}」/ B「{axis.get('b')}」")
    elif axis.get("level") == "semantic":
        lines.append("- 登记的争议对象措辞没有直接对齐，但两段完整观点共享多个有效概念，请结合原文判断具体关联")
    elif axis.get("level") == "fallback":
        lines.append("- 两侧至少一方没有登记争议对象，对齐结论较弱，请自行确认是否真在裁决同一件事")

    stance = signals.get("stance") or {}
    if stance:
        lines.append(f"- 主张方向：A={stance.get('a')}，B={stance.get('b')}")

    cond = (signals.get("conditions") or {}).get("per_key") or {}
    if cond:
        readable = {"audience": "人群", "stage": "阶段", "premise": "前提"}
        parts = [f"{readable[k]}={v}" for k, v in cond.items() if k in readable]
        lines.append("- 适用条件重叠情况：" + "，".join(parts))
    if not (signals.get("conditions") or {}).get("both_stated_keys"):
        lines.append("- 提醒：双方都没有明确限定适用条件，「条件分歧」这一判定缺少结构化依据")

    similarity = signals.get("similarity") or {}
    if similarity:
        lines.append(f"- 两个观点措辞相似度：{similarity.get('value')}"
                     f"（超过 {similarity.get('limit')} 即视为共识，已通过该闸门）")

    hits = signals.get("excludes_cross_hit") or []
    if hits:
        for hit in hits[:2]:
            side = "A 明确排除了 B 的做法" if hit["direction"] == "a_excludes_b" else "B 明确排除了 A 的做法"
            lines.append(f"- 已核到直接排除关系：{side}（被排除：{hit['excluded']}）")
    else:
        lines.append("- 双方都没有在原文中明确排除对方的做法（这通常意味着分歧较弱，请谨慎判断）")

    conflict = signals.get("conflict_signals") or []
    if conflict:
        lines.append("- 已命中的客观分歧信号：" + "；".join(item["detail"] for item in conflict))
    # 只有强信号才足以支撑「这是一组冲突」的结论。没有强信号时——无论是完全没命中，
    # 还是只命中了靠相似度推断的弱信号——都要提示模型继续考虑关联类关系，
    # 否则弱信号会被当成冲突证据，重新把互补型配对挤回二选一的老路。
    if not any(item.get("code") in STRONG_CONFLICT_CODES for item in conflict):
        lines.append("- 未命中强冲突信号，但两边讨论对象相关；请继续判断是否存在互补、适用边界或共同盲点")
    return "\n".join(lines)
