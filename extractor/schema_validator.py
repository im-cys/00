# -*- coding: utf-8 -*-
"""文章观点树 v2 的结构校验、原文定位与结构化语义字段规整。

两条设计约束：

1. 可碰撞层级的唯一标准是「节点承载的信息密度」，不是树的物理层数。
   同一回答的不同分支可以在不同深度停下，判据只有密度带。

2. 结构化语义字段（axis / stance / conditions / excludes）缺失时**降级不丢弃**。
   单篇结构图生成实测约四分钟，丢节点会触发整树重试，代价远大于一个字段留空；
   下游 pair_screen 对空字段有兜底路径（axis 空则退回词重叠）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from quote_locator import locate_quote

SCHEMA_VERSION = "answer-tree-v2"
COLLISION_ROLES = {
    "conclusion", "criterion", "reason", "mechanism", "recommendation",
    "counterpoint", "qualification",
}
SUPPORT_TYPES = {"quote", "example", "experience", "fact", "reason", "procedure"}
STANCE_VALUES = {"should", "should_not", "conditional", "descriptive"}
STRENGTH_VALUES = {"absolute", "conditional", "tendency"}
CONDITION_KEYS = ("audience", "stage", "premise")

MAX_COLLISION_NODES = 10
MAX_ROOT_LEN = 80
MIN_DISPLAY_TEXT_LEN = 8
MAX_DISPLAY_TEXT_LEN = 32
# 观点解释：详情页用来展开这个判断的前提、理由与边界。
MIN_EXPLANATION_LEN = 40         # 低于此值说明没讲透，不采用
MAX_EXPLANATION_LEN = 220        # 展示上限
EXPLANATION_ECHO_MAX = 0.62      # 与 statement 的二元组相似度上限，超过视为复读
MAX_BRANCH_TITLE_LEN = 12
MAX_BRANCH_SUMMARY_LEN = 45
MAX_STATEMENT_LEN = 110
MAX_REASON_LEN = 100
MAX_AXIS_LEN = 24
MAX_CONDITION_LEN = 14
MAX_EXCLUDE_LEN = 24
MAX_TRADEOFF_LEN = 30
MAX_SUPPORT_SUMMARY_LEN = 60
MAX_QUOTE_LEN = 180

# 密度带：跨回答共用的绝对标准，不随文章长短变化。
DENSITY_TARGET_MIN = 40
DENSITY_TARGET_MAX = 75
DENSITY_HARD_MIN = 32
DENSITY_HARD_MAX = 95
DENSITY_MAX_SPREAD = 30
DENSITY_MAX_RATIO = 2.0
# 严重失配阈值：只有越过它才值得再花一次模型调用重试（见 run_extract）。
DENSITY_SEVERE_SPREAD = 45
DENSITY_SEVERE_RATIO = 2.6

_LEADING_DEIXIS = re.compile(r"^(这|那|它|他们|她们|其|该|此|上述|如前所述)[，,、]?")
_REPORT_FRAME = re.compile(r"^(作者|答主|楼主|题主|本文|该回答)(认为|提到|指出|表示|说|强调|建议)[，,：:]?")
_REPORT_INLINE = re.compile(r"(作者|答主|楼主|题主|本文)(认为|提到|指出|表示|强调|建议)[，,：:]?")
_DISPLAY_FRAME = re.compile(
    r"^(?:(?:作者|答主|楼主|题主|本文|该回答)(?:认为|觉得|主张|建议)?|"
    r"(?:我认为|我觉得|在我看来|我的判断是))[，,：:]?"
)
_DISPLAY_JUDGMENT = re.compile(
    r"(应该|不该|不应|应|不要|要|需要|无需|不必|不能|可以|"
    r"优先|先|避免|保留|选择|放弃|更|比|取决于|取决|值得|不值得|"
    r"适合|不适合|能|会|主导|提供|兼顾|降低|增加|减少|看重|关注|强调|限制|支持|反对|"
    r"决定|影响|依赖|受限|高于|低于|倾向|并非|不是|没有|是|有)"
)
_DISPLAY_INCOMPLETE_END = re.compile(r"(的|与|和|或|但|而|并|且|因为|因此|更|比|应|要|在|时)[。！？!?]?$")
_DISPLAY_GENERIC = re.compile(r"^(总观点|核心观点|回答总结|信息与后路|避坑与例外|为什么|具体建议|其他)$")
_TITLE_PREFIX = re.compile(r"^(核心观点|观点|结论|标题|要点|判断|小结|总结|关于[^：:]{0,12})[：:]\s*")
_LIST_MARKER = re.compile(r"(^|[，,；;])\s*(?:\d{1,2}[.、)）]|[①-⑩]|[一二三四五六七八九十][、.])\s*")
_INNER_BREAK = re.compile(r"[。！？!?；;\n\r]+")
_FIRST_PERSON = re.compile(r"(我|咱|自己这边)")
_META_PAT = re.compile(r"(谢邀|先说结论|利益相关|匿了|码字不易|未完待续|手机码字)")

# stance 兜底推断：模型漏填时用表述特征判断，不留空。
_NEGATIVE_ADVICE = re.compile(r"(不建议|不要|别|不应|不该|不宜|反对|劝你别|与其|不必|无需|不值得)")
_POSITIVE_ADVICE = re.compile(r"(应该|该|建议|不妨|最好|优先|值得|推荐|我会选|请)")
_CONDITIONAL = re.compile(r"(如果|假如|视|取决于|因人而异|分情况|要看|一旦|只要|除非)")
# 排除表述：excludes 必须有这类原文依据才可信。
_EXCLUDE_CUE = re.compile(r"(不建议|不要|不是|别|而不是|与其|不应|不该|不宜|反对|不必|无需|不值得|少去)")


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


def _clip(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _clean_statement(value: Any, limit: int, rep: Report) -> str:
    """清洗为作者视角的一句话：去标题前缀、去第三人称转述框架、去列表编号。"""
    text = str(value or "").strip().strip("。. ")
    cleaned = _TITLE_PREFIX.sub("", text).strip()
    if cleaned != text:
        rep.fix("观点去除标题式前缀", {"before": text, "after": cleaned})
    without_frame = _REPORT_FRAME.sub("", cleaned).strip()
    if without_frame != cleaned:
        rep.fix("观点去除转述框架", {"before": cleaned, "after": without_frame})
        cleaned = without_frame
    delisted = _LIST_MARKER.sub(lambda m: m.group(1) or "", cleaned).strip("，,、 ")
    if delisted != cleaned:
        rep.fix("观点去除列表编号", {"before": cleaned, "after": delisted})
        cleaned = delisted
    if len(cleaned) > limit:
        rep.fix("观点文本超长截断", {"length": len(cleaned), "text": cleaned})
        cleaned = cleaned[:limit]
    return cleaned


def _normalize_display_text(value: Any, statement: str, rep: Report) -> str:
    """结构图卡片的完整短总结。

    display_text 只影响卡片展示，不能因为一个短标题瑕疵让整棵观点树和
    已定位的原文依据作废。模型输出不合格时做确定性清洗并记录修复；
    完整 statement 仍保留在详情页，不会丢失观点语义。
    """
    given = str(value or "").strip().strip("。.；;，, ")
    if not given:
        given = statement
        rep.fix("缺少 display_text，已从完整观点生成兼容短文本", statement[:40])
    text = _TITLE_PREFIX.sub("", given).strip()
    text = _DISPLAY_FRAME.sub("", text).strip("，,：: ")
    text = _LIST_MARKER.sub(lambda match: match.group(1) or "", text).strip("，,、 ")
    if value:
        problems = []
        if len(text) < MIN_DISPLAY_TEXT_LEN:
            problems.append("过短")
        if len(text) > MAX_DISPLAY_TEXT_LEN:
            problems.append("超过硬上限")
        if "…" in text or "..." in text:
            problems.append("含省略号")
        if _DISPLAY_GENERIC.fullmatch(text):
            problems.append("只是类目词")
        if _DISPLAY_INCOMPLETE_END.search(text):
            problems.append("句子未完成")
        if not _DISPLAY_JUDGMENT.search(text):
            problems.append("没有明确判断")
        if problems:
            before = text
            # 常见失败是模型在短标题末尾留下“因此/但是”等连接词；先去掉它，
            # 再优先选 statement 中 32 字以内、能独立成立的完整分句。
            text = re.sub(r"[，,：:；;]?(?:因此|所以|但是|但|而且|并且|因为|以及|同时|从而)$", "", text).strip()
            candidates = [text]
            clean_statement = str(statement or "").strip().strip("。.；;，, ")
            candidates.append(clean_statement)
            candidates.extend(
                part.strip() for part in re.split(r"[。！？!?；;]", clean_statement)
                if part.strip()
            )
            chosen = next((candidate for candidate in candidates
                           if MIN_DISPLAY_TEXT_LEN <= len(candidate) <= MAX_DISPLAY_TEXT_LEN
                           and not _DISPLAY_INCOMPLETE_END.search(candidate)
                           and _DISPLAY_JUDGMENT.search(candidate)), "")
            if not chosen:
                chosen = (clean_statement or text or before)[:MAX_DISPLAY_TEXT_LEN]
                chosen = re.sub(r"[，,：:；;]?(?:因此|所以|但是|但|而且|并且|因为|以及|同时|从而)$", "", chosen).strip("，,：:；; ")
            text = chosen or before[:MAX_DISPLAY_TEXT_LEN]
            rep.fix("display_text 不合格，已生成兼容短总结", {
                "before": before, "after": text, "problems": problems,
            })
    return text or statement[:MAX_DISPLAY_TEXT_LEN]


def _bigram_set(text: Any) -> set[str]:
    """中文二元组集合。只用于判断 explanation 是否只是 statement 的改写。"""
    clean = re.sub(r"[^\u3400-\u9fff]+", "", str(text or ""))
    return {clean[at:at + 2] for at in range(len(clean) - 1)}


def _echo_ratio(explanation: str, statement: str) -> float:
    """explanation 里已经出现在 statement 中的二元组占比。

    取 explanation 作分母：比值高说明它讲的东西 statement 里已经有了，
    属于复读；正常的解释会引入前提、理由和边界，分母变大、比值自然降低。
    """
    left = _bigram_set(explanation)
    if not left:
        return 0.0
    return round(len(left & _bigram_set(statement)) / len(left), 3)


def _normalize_explanation(value: Any, statement: str, rep: Report) -> str:
    """观点解释：详情页展开这个判断的前提、理由与边界。

    与 display_text 不同，这里**不做硬失败**。它只影响展示，而单篇结构图生成
    实测约四分钟，为一个展示字段触发整树重试不划算。不合格就返回空串，
    前端自行降级显示 statement。
    """
    text = str(value or "").strip()
    if not text:
        rep.fix("collision 缺少 explanation，详情页将降级显示完整观点", statement[:30])
        return ""
    if len(text) < MIN_EXPLANATION_LEN:
        rep.fix("explanation 过短，未采用", {"statement": statement[:24], "length": len(text)})
        return ""
    echo = _echo_ratio(text, statement)
    if echo > EXPLANATION_ECHO_MAX:
        rep.fix("explanation 只是复读 statement，未采用", {
            "statement": statement[:24], "echo_ratio": echo, "limit": EXPLANATION_ECHO_MAX,
        })
        return ""
    return text[:MAX_EXPLANATION_LEN]


# ---------------------------------------------------------------------------
# 结构化语义字段
# ---------------------------------------------------------------------------

def _normalize_axis(value: Any, statement: str, rep: Report) -> str:
    """争议对象。缺失时不丢节点，留空交给 pair_screen 的词重叠兜底。"""
    axis = _clip(value, MAX_AXIS_LEN)
    if not axis:
        rep.fix("collision 缺少 axis，跨回答比对将退回词重叠", statement[:30])
        return ""
    # 话题式单词（"专业选择"）无法比对，但也不该丢；如实保留并标记。
    if len(axis) < 5:
        rep.fix("axis 过短，可能是话题而非可判定对象", axis)
    return axis


def _normalize_stance(value: Any, statement: str, rep: Report) -> str:
    """主张方向。这是 pair_screen 的核心判据，漏填时按表述特征兜底推断。"""
    stance = str(value or "").strip()
    if stance in STANCE_VALUES:
        return stance
    if _NEGATIVE_ADVICE.search(statement):
        guessed = "should_not"
    elif _CONDITIONAL.search(statement):
        guessed = "conditional"
    elif _POSITIVE_ADVICE.search(statement):
        guessed = "should"
    else:
        guessed = "descriptive"
    rep.fix("stance 缺失或非法，按表述特征推断", {"given": stance or None, "guessed": guessed})
    return guessed


def _normalize_conditions(value: Any) -> dict[str, list[str]]:
    """适用条件按 audience / stage / premise 拆项，空数组表示普遍适用。"""
    raw = value if isinstance(value, dict) else {}
    result: dict[str, list[str]] = {}
    for key in CONDITION_KEYS:
        given = raw.get(key)
        items = given if isinstance(given, list) else ([given] if isinstance(given, str) else [])
        cleaned: list[str] = []
        for item in items:
            text = _clip(item, MAX_CONDITION_LEN)
            if text and text not in cleaned:
                cleaned.append(text)
        result[key] = cleaned[:3]
    return result


def _legacy_scope_into_conditions(conditions: dict, legacy: Any) -> dict:
    """兼容仍输出扁平 scope 的模型：并入 premise，不丢信息。"""
    if any(conditions[key] for key in CONDITION_KEYS):
        return conditions
    items = legacy if isinstance(legacy, list) else ([legacy] if isinstance(legacy, str) else [])
    merged = []
    for item in items:
        text = _clip(item, MAX_CONDITION_LEN)
        if text and text not in merged:
            merged.append(text)
    if merged:
        conditions = {**conditions, "premise": merged[:3]}
    return conditions


def _flatten_conditions(conditions: dict) -> list[str]:
    flat = []
    for key in CONDITION_KEYS:
        for item in conditions.get(key) or []:
            if item not in flat:
                flat.append(item)
    return flat


def _normalize_excludes(value: Any, source: str, statement: str, rep: Report) -> list[str]:
    """作者明确排除的替代做法。必须有原文排除表述兜底，否则视为虚构并丢弃该条。

    这是取代旧 _counter 的字段：旧字段要求模型虚构一句反对意见，产出质量全看
    运气；本字段要求原文出现过排除表述，可核对，也是 pair_screen 判定真冲突的
    最强信号（一方的主张落在另一方的排除项里）。
    """
    items = value if isinstance(value, list) else ([value] if isinstance(value, str) else [])
    result: list[str] = []
    has_cue = bool(_EXCLUDE_CUE.search(source))
    for item in items:
        text = _clip(item, MAX_EXCLUDE_LEN)
        if not text or text in result:
            continue
        if not has_cue:
            rep.fix("excludes 在原文中找不到排除表述，已丢弃", {"statement": statement[:24], "excluded": text})
            continue
        result.append(text)
    return result[:2]


def _sentence_shape(text: str) -> tuple[str, int]:
    inner = _INNER_BREAK.findall(text.rstrip("。！？!?；; \n"))
    if inner:
        return "multi_sentence", len(inner)
    return "single_sentence", 0


def _density_slots(text: str, conditions: dict, reason: str) -> int:
    """语义槽位数：核心判断恒为 1，另计适用条件与关键理由。"""
    slots = 1
    if _flatten_conditions(conditions) or re.search(
        r"(如果|若|一旦|对于|在[^，,]{1,12}(情况|条件|阶段|场景)|想要|打算|要的是|只要)", text
    ):
        slots += 1
    if reason or re.search(r"(因为|由于|原因在于|毕竟|之所以|这意味着|所以)", text):
        slots += 1
    return slots


def _audit_density(text: str, conditions: dict, reason: str) -> dict:
    """单节点密度画像。issues 为空表示落在密度带内。"""
    length = len(text)
    shape, inner_breaks = _sentence_shape(text)
    slots = _density_slots(text, conditions, reason)
    issues = []
    if length > DENSITY_HARD_MAX:
        issues.append("over_dense")
    elif length < DENSITY_HARD_MIN:
        issues.append("under_dense")
    elif not (DENSITY_TARGET_MIN <= length <= DENSITY_TARGET_MAX):
        issues.append("off_target_len")
    if shape != "single_sentence":
        issues.append("not_single_sentence")
    if slots > 3:
        issues.append("too_many_slots")
    if slots < 2:
        issues.append("too_few_slots")
    if _REPORT_INLINE.search(text):
        issues.append("third_person_frame")
    return {
        "length": length,
        "slots": slots,
        "shape": shape,
        "inner_breaks": inner_breaks,
        "first_person": bool(_FIRST_PERSON.search(text)),
        "issues": issues,
    }


def _dedupe_anchors(anchors: list[dict], limit: int = 8) -> list[dict]:
    found = []
    seen = set()
    for anchor in sorted(anchors, key=lambda item: item.get("start", 10**9)):
        key = (anchor.get("start"), anchor.get("end"), anchor.get("quote"))
        if key in seen:
            continue
        seen.add(key)
        found.append(anchor)
        if len(found) >= limit:
            break
    return found


def _collapse_redundant_branches(item: Any, rep: Report) -> Any:
    """折叠不承载组织信息的中间层，让 collision 停在它真正该停的深度。

    可碰撞层级由信息密度决定，不由物理层数决定。因此一个 branch 如果只有
    一个 collision 子节点，它就没有在「组织」任何东西——没有兄弟节点需要
    并列，这一层纯粹是噪声，会让用户以为还要再往下看。直接把 collision 上提。

    在 normalize_item 之前对原始输出做这一步，ancestor_path、group_id 和
    collision_depths 就都会按折叠后的真实结构自然算对，不需要事后修补。

    两种折叠：
      branch(唯一子节点是 collision) → 该 collision 取代 branch
      branch(唯一子节点是 branch)    → 内层 branch 取代外层（内层更具体）

    自底向上递归，所以 branch → branch → collision 这种链会一路折叠到底。
    root 永不折叠：每篇回答必须保留唯一总观点。
    """
    if not isinstance(item, dict):
        return item
    children = item.get("children")
    if not isinstance(children, list) or not children:
        return item

    collapsed_children = []
    for child in children:
        result = _collapse_redundant_branches(child, rep)
        if isinstance(result, dict):
            collapsed_children.append(result)
    item = {**item, "children": collapsed_children}

    if item.get("kind") != "branch" or len(collapsed_children) != 1:
        return item

    only = collapsed_children[0]
    only_kind = only.get("kind")
    if only_kind == "collision":
        rep.fix("单一 collision 的中间层已折叠，可碰撞节点直接上提", {
            "branch": _clip(item.get("title"), MAX_BRANCH_TITLE_LEN),
            "collision": _clip(only.get("statement"), 40),
        })
        return only
    if only_kind == "branch":
        rep.fix("单子分支的冗余外层已折叠", {
            "outer": _clip(item.get("title"), MAX_BRANCH_TITLE_LEN),
            "inner": _clip(only.get("title"), MAX_BRANCH_TITLE_LEN),
        })
        return only
    return item


def normalize(raw: dict, source: str, answer_id: str, question: str = "") -> tuple[dict, Report]:
    """把模型输出规整成观点树，并生成碰撞管道使用的 collision 节点表。"""
    rep = Report(answer_id=answer_id)
    if not isinstance(raw, dict):
        rep.ok, rep.fatal = False, "模型输出不是 JSON 对象"
        return {}, rep
    root_raw = raw.get("root")
    if not isinstance(root_raw, dict):
        rep.ok, rep.fatal = False, "缺少唯一 root"
        return {}, rep

    root_statement = _clean_statement(root_raw.get("statement"), MAX_ROOT_LEN, rep)
    if not root_statement:
        rep.ok, rep.fatal = False, "root 缺少总观点"
        return {}, rep
    root_display_text = _normalize_display_text(root_raw.get("display_text"), root_statement, rep)

    counters = {"branch": 0, "collision": 0, "support": 0}
    quote_methods: list[str] = []
    collision_nodes: list[dict] = []
    collision_depths: list[int] = []

    def normalize_support(item: Any, collision_id: str) -> dict | None:
        if not isinstance(item, dict):
            return None
        raw_quote = item.get("quote")
        located = locate_quote(source, raw_quote) if isinstance(raw_quote, str) else None
        if not located:
            rep.drop("support.quote 无法在原文定位", raw_quote)
            return None
        counters["support"] += 1
        quote_methods.append(located.method)
        support_type = item.get("type") if item.get("type") in SUPPORT_TYPES else "quote"
        if support_type != item.get("type"):
            rep.fix("support.type 非法，降级为 quote", item.get("type"))
        quote = located.text[:MAX_QUOTE_LEN]
        return {
            "id": f"{collision_id}_s{counters['support']}",
            "type": support_type,
            "summary": _clip(item.get("summary"), MAX_SUPPORT_SUMMARY_LEN),
            "quote": quote,
            "char_offset": located.start,
            "char_end": located.start + len(quote),
            "match_method": located.method,
        }

    def normalize_item(item: Any, depth: int, path: list[dict], group_id: str | None = None) -> dict | None:
        if not isinstance(item, dict):
            return None
        kind = item.get("kind")
        if kind == "collision":
            if counters["collision"] >= MAX_COLLISION_NODES:
                rep.drop("collision 超过数量上限", item.get("statement"))
                return None
            statement = _clean_statement(item.get("statement"), MAX_STATEMENT_LEN, rep)
            if not statement or _META_PAT.search(statement):
                rep.drop("collision 缺少有效观点", statement)
                return None
            if _LEADING_DEIXIS.match(statement):
                rep.drop("collision 含无指代对象的开头", statement)
                return None

            counters["collision"] += 1
            collision_id = f"{answer_id}_c{counters['collision']}"
            supports = []
            for support_raw in item.get("supports") or []:
                support = normalize_support(support_raw, collision_id)
                if support:
                    supports.append(support)
                if len(supports) >= 2:
                    break
            if not supports:
                counters["collision"] -= 1
                rep.drop("collision 没有可定位的原文支撑", statement)
                return None
            if item.get("children"):
                rep.fix("collision 的 children 已忽略", statement)

            role = item.get("role") if item.get("role") in COLLISION_ROLES else "reason"
            if role != item.get("role"):
                rep.fix("collision.role 非法，降级为 reason", item.get("role"))

            axis = _normalize_axis(item.get("axis"), statement, rep)
            stance = _normalize_stance(item.get("stance"), statement, rep)
            conditions = _legacy_scope_into_conditions(
                _normalize_conditions(item.get("conditions")), item.get("scope")
            )
            excludes = _normalize_excludes(item.get("excludes"), source, statement, rep)
            strength = item.get("strength") if item.get("strength") in STRENGTH_VALUES else None
            tradeoff = _clip(item.get("tradeoff"), MAX_TRADEOFF_LEN) or None
            not_applicable = _clip(item.get("not_applicable"), MAX_TRADEOFF_LEN) or None
            reason_summary = _clip(item.get("reason_summary"), MAX_REASON_LEN)
            display_text = _normalize_display_text(item.get("display_text"), statement, rep)
            explanation = _normalize_explanation(item.get("explanation"), statement, rep)

            density = _audit_density(statement, conditions, reason_summary)
            # 密度过高几乎一定是一个节点塞了多个争议轴，直接判失配；
            # 其余偏差只记录，避免把可用节点删空后触发整树重试。
            if "over_dense" in density["issues"]:
                counters["collision"] -= 1
                rep.drop("collision 信息密度过高（超出密度带硬上限）", {
                    "statement": statement, "length": density["length"], "limit": DENSITY_HARD_MAX,
                })
                return None
            if density["issues"]:
                rep.fix("collision 密度偏离目标带", {
                    "statement": statement, "issues": density["issues"],
                    "length": density["length"], "slots": density["slots"],
                })

            anchors = [{
                "quote": support["quote"],
                "start": support["char_offset"],
                "end": support["char_end"],
                "method": support["match_method"],
            } for support in supports]
            ancestor_path = [{"id": entry["id"], "text": entry["text"]} for entry in path]

            semantics = {
                "axis": axis,
                "stance": stance,
                "conditions": conditions,
                "excludes": excludes,
                "strength": strength,
                "tradeoff": tradeoff,
                "not_applicable": not_applicable,
            }
            # 可见树节点：只放渲染与选中判定需要的字段。
            visible = {
                "id": collision_id,
                "kind": "collision",
                "display_text": display_text,
                "statement": statement,
                "explanation": explanation,
                "collision_role": role,
                "collidable": True,
                "source_anchors": anchors,
                "support_count": len(supports),
                "children": [],
                **semantics,
                "density": density,
            }
            # 碰撞节点表：pair_screen 与 context_pack 的输入。
            collision_nodes.append({
                "id": collision_id,
                "answer_id": answer_id,
                "group_id": group_id or f"{answer_id}_root",
                "collision_role": role,
                "display_text": display_text,
                "statement": statement,
                "explanation": explanation,
                "reason_summary": reason_summary,
                "quote": anchors[0]["quote"],
                "char_offset": anchors[0]["start"],
                "source_anchors": anchors,
                "supports": supports,
                "ancestor_path": ancestor_path,
                **semantics,
                "density": density,
            })
            collision_depths.append(depth)
            return visible

        if kind != "branch":
            rep.fix("非 collision 节点按 branch 处理", kind)
        title = _clip(item.get("title"), MAX_BRANCH_TITLE_LEN)
        summary = _clip(item.get("summary"), MAX_BRANCH_SUMMARY_LEN)
        if not title:
            title = summary[:MAX_BRANCH_TITLE_LEN]
        if not title:
            rep.drop("branch 缺少标题", item)
            return None
        display_text = _normalize_display_text(item.get("display_text"), summary or title, rep)
        counters["branch"] += 1
        branch_id = f"{answer_id}_b{counters['branch']}"
        own_group_id = branch_id if depth == 1 else group_id
        own_path = path + [{"id": branch_id, "text": title}]
        children = []
        for child_raw in item.get("children") or []:
            child = normalize_item(child_raw, depth + 1, own_path, own_group_id)
            if child:
                children.append(child)
        if not children:
            rep.drop("branch 下没有有效 collision", title)
            return None
        return {
            "id": branch_id,
            "kind": "branch",
            "title": title,
            "display_text": display_text,
            "summary": summary,
            "collidable": False,
            "source_anchors": _dedupe_anchors([
                anchor for child in children for anchor in child.get("source_anchors", [])
            ]),
            "children": children,
        }

    root_id = f"{answer_id}_root"
    root_path = [{"id": root_id, "text": root_statement}]
    children = []
    # 先折叠不承载组织信息的中间层，再规整。这样 ancestor_path、group_id 和
    # collision_depths 都按折叠后的真实结构计算，已达到密度带的观点不会被
    # 多套一层 branch 而显得「还需要再往下拆」。
    for child_raw in root_raw.get("children") or []:
        collapsed = _collapse_redundant_branches(child_raw, rep)
        child = normalize_item(collapsed, 1, root_path, None)
        if child:
            children.append(child)
    if not children or not collision_nodes:
        rep.ok, rep.fatal = False, "观点树没有通过校验的 collision 叶子"
        return {}, rep

    tree = {
        "id": root_id,
        "kind": "root",
        "title": "总观点",
        "display_text": root_display_text,
        "statement": root_statement,
        "collidable": False,
        "source_anchors": _dedupe_anchors([
            anchor for child in children for anchor in child.get("source_anchors", [])
        ]),
        "children": children,
    }

    boundaries = []
    for index, item in enumerate(raw.get("boundaries") or [], 1):
        if not isinstance(item, dict):
            continue
        summary = _clip(item.get("summary"), MAX_REASON_LEN)
        quote = item.get("quote")
        located = locate_quote(source, quote) if isinstance(quote, str) else None
        if not summary or not located:
            rep.drop("boundary 缺少摘要或原文定位", item)
            continue
        boundaries.append({
            "id": f"{answer_id}_boundary{index}",
            "summary": summary,
            "quote": located.text[:MAX_QUOTE_LEN],
            "char_offset": located.start,
        })

    groups = []
    direct_root_added = False
    for child in children:
        if child["kind"] == "branch":
            gid, title, summary = child["id"], child["title"], child.get("summary", "")
        else:
            gid, title, summary = root_id, "核心观点", root_statement
            if direct_root_added:
                continue
            direct_root_added = True
        groups.append({
            "answer_id": answer_id,
            "group_id": gid,
            "order": len(groups) + 1,
            "title": title,
            "summary": summary,
            "start_offset": min(
                (anchor["start"] for anchor in child.get("source_anchors", [])), default=0
            ),
        })

    lengths = [len(node["statement"]) for node in collision_nodes]
    spread = max(lengths) - min(lengths)
    ratio = round(max(lengths) / max(1, min(lengths)), 2)
    off_band = [node["id"] for node in collision_nodes if node["density"]["issues"]]
    multi_sentence = [
        node["id"] for node in collision_nodes if node["density"]["shape"] != "single_sentence"
    ]
    aligned = spread <= DENSITY_MAX_SPREAD and ratio <= DENSITY_MAX_RATIO and not multi_sentence
    # 只有严重失配才值得再花一次模型调用；轻微偏离目标带不触发重试。
    severe = (
        spread > DENSITY_SEVERE_SPREAD
        or ratio > DENSITY_SEVERE_RATIO
        or len(multi_sentence) > 1
    )
    axes = [node["axis"] for node in collision_nodes if node["axis"]]

    rep.stats.update({
        "schema_version": SCHEMA_VERSION,
        "branch_count": counters["branch"],
        "collision_count": len(collision_nodes),
        "support_count": counters["support"],
        "collision_depth_min": min(collision_depths),
        "collision_depth_max": max(collision_depths),
        "collision_statement_avg_len": round(sum(lengths) / len(lengths), 1),
        "density": {
            "band_target": [DENSITY_TARGET_MIN, DENSITY_TARGET_MAX],
            "band_hard": [DENSITY_HARD_MIN, DENSITY_HARD_MAX],
            "len_min": min(lengths),
            "len_max": max(lengths),
            "len_spread": spread,
            "len_ratio": ratio,
            "spread_limit": DENSITY_MAX_SPREAD,
            "ratio_limit": DENSITY_MAX_RATIO,
            "slots_min": min(node["density"]["slots"] for node in collision_nodes),
            "slots_max": max(node["density"]["slots"] for node in collision_nodes),
            "first_person_rate": round(
                sum(1 for node in collision_nodes if node["density"]["first_person"]) / len(collision_nodes), 2
            ),
            "off_band_ids": off_band,
            "multi_sentence_ids": multi_sentence,
            "aligned": aligned,
            "severe": severe,
        },
        "density_aligned": aligned,
        "semantics": {
            "axis_filled": len(axes),
            "axis_missing": len(collision_nodes) - len(axes),
            "axes": axes,
            "stance_mix": {
                value: sum(1 for node in collision_nodes if node["stance"] == value)
                for value in sorted(STANCE_VALUES)
                if any(node["stance"] == value for node in collision_nodes)
            },
            "with_conditions": sum(
                1 for node in collision_nodes if _flatten_conditions(node["conditions"])
            ),
            "with_excludes": sum(1 for node in collision_nodes if node["excludes"]),
        },
        "quote_match": {method: quote_methods.count(method) for method in ("exact", "normalized", "fuzzy")},
        "boundary_count": len(boundaries),
        "dropped_count": len(rep.dropped),
    })

    return {
        "schema_version": SCHEMA_VERSION,
        "answer_id": answer_id,
        "question": question,
        "tree": tree,
        "groups": groups,
        "nodes": collision_nodes,
        "boundaries": boundaries,
    }, rep
