# -*- coding: utf-8 -*-
"""碰撞引擎：判断两个观点的关系，并由该关系引申出一个新问题。

设计原则（改动前请先读）：

1. **判定与提问分两次调用**：
   旧版一次调用同时要求「判断关系 + 写出问题 + 给出 evidence」，模型一旦开口
   就已经预设了关系成立，`无有效关系` 形同虚设。现在第一步只判关系，不合格
   直接结束，不进入提问。

2. **冲突类关系带举证责任**：
   声称冲突必须同时给出 shared_axis（共同裁决对象）、overlap_case（同时落入
   双方适用范围的具体情形）、incompatible_because（在该情形下为何两个结论不能
   同时接受）。三项缺一即判无结果。
   实测误判案例：A「30岁会面临创业或继续打工的选择」× B「有家庭的别冲动辞职，
   先做副业」被判成「条件分歧」并生成了有漏洞的问题。加上举证责任后，模型必须
   写出「一个既在30岁分岔口、又有家庭负担、且两人建议冲突的具体人」——写不出来，
   因为 B 是 A 那个分岔口的一个具体解法。

3. **区分真分歧与措辞差**：
   dispute_scale 采用**白名单**：只有明确填写 substantive 才继续产出问题。
   填 superficial、留空或填非法值一律 no_result。
   旧版只拦 superficial，漏填就直接放行，是通过率过高的主要来源之一。

4. **碰撞不只等于正面对立**：
   同一对象上的互补视角、条件差异和共同前提，也可能引出值得回答的新问题。
   只有明显无关或近乎重复的组合才直接 no_result。

v5 放宽：保留冲突类的三项举证与原文回查，但不再把“互补细化”和“共识支撑”
直接判为无结果。只要两侧都提供可定位的原文依据，并能说明共同对象，就继续生成
组合方法、适用边界或共同盲点问题。这样放宽关系类型，但不放松证据真实性。

各项阈值集中在文件顶部常量区，调整通过率只改那里。

提问闸门沿用 `question_validator.validate_question`（零 LLM 调用，阈值 0.82）。
"""

from __future__ import annotations

import re

from run_extract import call_llm_resilient, parse_json
from context_pack import build_context_pack, render_pack  # noqa: F401  (对外沿用)
from pair_screen import render_screen
from question_validator import validate_question

# ---------------------------------------------------------------------------
# 关系类型。由模型判定，不由用户选择。
# ---------------------------------------------------------------------------
RELATION_TYPES = [
    "归因冲突",   # 把同一现象归到互斥的原因上
    "机制冲突",   # 对「怎么运作的」给出互斥描述
    "直接对立",   # 正面相反的主张
    "元层冲突",   # 一方给答案，一方否认存在答案
    "条件分歧",   # 结论不同源于适用前提不同
    "共识支撑",   # 表面不同，实则共享同一判断
    "互补细化",   # 一方是另一方在更窄条件下的具体做法（相容，不是分歧）
    "无有效关系",  # 讨论对象差太远，碰不出东西
]

NO_RESULT = "无有效关系"
COMPLEMENTARY = "互补细化"
CONSENSUS = "共识支撑"
# 声称这些关系必须完成举证。
CONFLICT_TYPES = {"归因冲突", "机制冲突", "直接对立", "元层冲突", "条件分歧"}
# 互补与共识并非冲突，但只要两侧原文都能支撑一个共同对象，仍可引出组合方法、
# 适用边界或共同盲点问题。真正不产出问题的只有“无有效关系”。
RELATED_TYPES = {COMPLEMENTARY, CONSENSUS}
NON_PRODUCTIVE = {NO_RESULT}

# ---------------------------------------------------------------------------
# 举证质量阈值。收紧通过率时只调这里。
# ---------------------------------------------------------------------------
MIN_SHARED_AXIS_LEN = 6          # 共同裁决对象
MIN_OVERLAP_CASE_LEN = 12        # 条件重叠情形，必须具体到能想象出这个人
MIN_INCOMPATIBLE_LEN = 20        # 不相容理由，必须说清「照 A 做就无法照 B 做」
MIN_RELATION_TEXT_LEN = 60       # 详情页 AI 分析
MIN_RELATION_EVIDENCE = 2        # 声称冲突至少要两条依据
MIN_QUESTION_DETAIL_LEN = 40     # 问题详情说明，低于此值视为空话，改用结构化字段兜底
MAX_QUESTION_DETAIL_LEN = 240    # 详情页展示上限
# 举证字段里出现这些说法，等于没有举证：它们只是把要求复述了一遍。
_VAGUE_EVIDENCE = re.compile(
    r"^(这个人|某个人|某些人|一个人|有些人|这种人|这类人|读者|用户|大家|"
    r"不能同时接受|无法同时成立|互相矛盾|彼此冲突|两者冲突|存在分歧|有分歧|"
    r"同上|见上|如上|待补充|无|暂无|不适用|n/?a)[。.！!]?$"
)

# ---------------------------------------------------------------------------
# 第一步：关系判定
# ---------------------------------------------------------------------------
SYS_RELATION = """你是一个「关系判定器」。

给你同一个问题下**两篇不同回答**中各一个观点，以及它们各自的原文片段和已经算好的结构化比对结果。

你只做一件事：判断这两个观点是什么关系。**这一步不要写新问题。**

只输出 JSON，不要解释，不要 markdown 围栏。

────────── 关系取值 ──────────

relation_type 必须从以下取值中选一个：

- 归因冲突：把同一现象归到互斥的原因上
- 机制冲突：对「它是怎么运作的」给出互斥描述
- 直接对立：正面相反的主张
- 元层冲突：一方给出确定答案，一方否认存在答案
- 条件分歧：结论不同，根源是各自预设的适用前提不同
- 共识支撑：表面像分歧，实则共享同一个未言明的判断
- 互补细化：一方是另一方在更窄条件下的具体做法，两者相容，不构成分歧
- 无有效关系：两者裁决的根本不是一回事

不要把“碰撞”机械理解成正面对立。两个人各说一面时，如果它们共同回答同一个对象，
组合后能暴露适用边界、取舍方法或共同遗漏的问题，应判「互补细化」或「共识支撑」。
只有裁决对象确实无关，或两句话近乎重复且没有新增信息时，才判「无有效关系」。
硬凑冲突仍然是错误，但识别有依据的关联是本任务的一部分。

────────── 举证责任（最重要）──────────

如果你选择「归因冲突/机制冲突/直接对立/元层冲突/条件分歧」中任意一个，
必须同时填写下面三个字段。**任何一项写不出来，就说明这不是冲突**，
请改判为「互补细化」或「无有效关系」：

1. shared_axis：两人共同裁决的那个对象。必须是同一件事，不是同一个话题。至少 6 字。
   ✗「都在讲职业规划」——这是话题，不是裁决对象。
   ✓「30岁时该不该辞职创业」——这是可判定的同一件事。

2. overlap_case：一个**同时落入双方适用范围**的具体情形或人群。至少 12 字。
   必须具体到能想象出这个人：要带上身份、处境或约束条件。
   如果双方的适用条件没有交集，写不出这个情形，那就不是冲突——改判「无有效关系」。
   ✗「这个人」「某些读者」「用户」——这不是举证，是把要求复述了一遍。
   ✓「一个30岁、有房贷和孩子、但现在工作很不开心的人」

3. incompatible_because：在 overlap_case 这个情形下，为什么两个结论**不能同时接受**。至少 20 字。
   必须具体说明「照 A 做就无法照 B 做」在哪里，指出被牺牲的那个东西。
   ✗「两者不能同时接受」「存在矛盾」——同样是复述要求，不是举证。
   ✓「照 A 立刻辞职就拿不到 B 说的副业验证期，房贷断供的风险要由家人承担」
   如果两个建议可以同时执行，或者一个只是另一个的具体做法，那就是「互补细化」。

如果你选择「互补细化」或「共识支撑」，shared_axis 仍然必填，说明两边共同回答的
具体对象；relation_text 要说明两者怎样互相补充、各自覆盖什么，以及组合后还能追问
哪个适用边界、取舍或共同盲点。不要为了通过而伪造 incompatible_because。

特别注意「条件分歧」：它最容易被滥用。只有当双方适用范围**有重叠**、
且在重叠处给出**不相容**结论时才成立。如果各自条件根本不重叠，那是「无有效关系」。
如果系统提示「双方都没有明确限定适用条件」，那么「条件分歧」缺少依据，不要选它。

特别注意「直接对立」：只有当一方明确排除了另一方的做法，或两人一个说该做、
一个说不该做时才成立。系统会拿结构化字段交叉核对，核不上会被退回。

────────── 分歧强度 ──────────

dispute_scale 从两个取值中选：

- substantive：真实分歧。在 overlap_case 下，两人会给出实际相反的行动或判断。
- superficial：只是强度、措辞、侧重或详略不同，实际主张一致。

冲突类关系只有明确填写 substantive 才会继续产出问题；「互补细化」和「共识支撑」
可以填写 superficial，因为它们的价值来自关联而不是对立。所以不要为了让流程走下去而填 substantive——
先问自己：那个具体的人照 A 做和照 B 做，最后的行动真的不一样吗？
如果只是「一个说得更强硬、一个说得更委婉」，那就是 superficial。

────────── 引用条数 ──────────

除「无有效关系」外，evidence **至少 2 条**，且必须双方各出至少一条。
无论判断冲突还是关联，都不能只凭一篇回答推测另一篇的意思。

────────── 关系说明 ──────────

relation_text 是结果详情页的主体「AI 分析」，80–240 字，写成 1–2 个自然段。
要像知乎回答的分析段落一样清楚：先说两个回答分别把哪个变量或标准放在了更重要的位置，
再说它们在哪个具体情形下会导向不同判断，以及这个差异为什么值得继续问。
不要只复述两个节点，不要引用节点 ID，不要裁定谁对谁错。
✗ 太空泛：「两人观点不同，各有道理。」
✓「两个回答都在判断专业的优先级，但放大的指标不同：一方更看重学校和城市条件，另一方更看重个人信息与长期选择空间。

当一个人同时面对学校层级、专业排名和就业选择时，这两套标准可能给出不同排序，真正值得追问的是哪个指标更能代表长期收益。」

────────── 引用铁律 ──────────

evidence 数组列出你依据的原文片段（逐字摘录，每条 10–60 字，最多 3 条）。
每条必须是原文中**连续的一段话**，不得拼接不相邻的句子，不得加省略号、不得跨段落拼接。
系统会拿回原文做字符串校验。

不要引入原文没有的社会情绪词。典型编造：「35岁」「转行」「被裁员」「内卷」「焦虑」
「中年危机」——除非原文真的出现，一律不许用。

────────── 输出格式 ──────────

{
  "relation_type": "上述取值之一",
  "dispute_scale": "substantive 或 superficial",
  "shared_axis": "两人共同讨论的具体对象（除无有效关系外必填）",
  "overlap_case": "同时落入双方适用范围的具体情形（冲突类必填）",
  "incompatible_because": "为何两个结论不能同时接受（冲突类必填）",
  "relation_text": "AI 分析说明，80–240字，1–2个自然段",
  "evidence": ["逐字摘自原文的依据1", "依据2"]
}"""

USER_RELATION_TPL = """【原问题】{question}

{pack_a}

────────────────────────────

{pack_b}

────────────────────────────

【系统已算好的结构化比对结果】
{screen}

请判断这两个观点的关系。
先在心里检查：能不能写出一个同时符合双方适用条件、且两人建议真的冲突的具体人？
写不出来就如实改判「互补细化」或「无有效关系」——这是受欢迎的结果，硬凑冲突才是失败。
只输出 JSON。"""


# ---------------------------------------------------------------------------
# 第二步：提问
# ---------------------------------------------------------------------------
SYS_QUESTION = """你是一个「提问者」。这是知乎——一个从问题出发的平台。

关系已经判定完毕，并通过了原文举证。你现在只做一件事：由这个关系引申出一个新问题。

只输出 JSON，不要解释，不要 markdown 围栏。

────────── 要求 ──────────

1. question 必须是一个问句，以问号结尾，**≤35 字，越短越有力**。

2. 如果是冲突类关系，问题应落在 overlap_case 上，追问同一情形下该如何取舍。
   如果是「互补细化/共识支撑」，问题应围绕 shared_axis，追问两种视角如何组合、
   各自何时适用，或两边共同没有回答的关键变量。不要硬写成二选一。

3. 不要提原问题的同义改写。新问题必须是原问题回答不了、
   但读完这两篇回答后才浮现出来的那个问题。

4. 不要提泛泛的问题（「你怎么看」「如何看待」「有什么影响」）。

5. 自检：把问题拿给读完这两篇回答的人看，他会想打字回复吗？
   如果他只会点头或摇头，说明问题不好。

────────── 问题详情说明 ──────────

question_detail 是问题卡片下方展示给读者的说明，60–160 字，1–2 句。
它要回答读者心里的「这问题到底在问什么、为什么值得答」，写清三件事：

1. 这个问题落在哪个共同对象或具体情形上；
2. 为什么两篇回答合在一起仍没答完——冲突时写不同动作，互补时写尚缺的边界或取舍；
3. 答它需要什么——读者应该提供哪一类经验或判断依据。

写法要求：
- 面向读者，用平实的陈述句，不要用「本问题旨在」「综上所述」这类论文腔。
- 不要重复问题标题的字面表述，也不要复述 AI 分析那一段。
- 不要下结论、不要偏向任何一方，你的角色是把问题的处境讲清楚。
- 不要出现「节点」「碰撞」「axis」等系统内部词汇，读者看不懂这些。

✗ 空话：「这个问题涉及职业选择的多个方面，值得深入探讨。」
✓ 「一个有房贷和孩子、又对现在工作不满的人，照甲的说法该立刻辞职抓住窗口，
   照乙的说法该先用副业验证。两条路的现金流风险完全不同，
   而两篇回答都没说清这种情形下该怎么取舍——有过类似处境的人最有资格回答。」

────────── 引用铁律 ──────────

问题里出现的每一个具体元素——数字、专有名词、身份标签、时间点、场景词——
都必须能在原文片段中找到出处。

evidence 数组列出依据的原文片段（逐字摘录，每条 10–60 字，最多 3 条），
必须是原文中连续的一段话，不得拼接不相邻的句子。系统会拿回原文校验，对不上整条丢弃。

不要引入原文没有的社会情绪词（「35岁」「转行」「被裁员」「内卷」「焦虑」「中年危机」等），
除非原文真的出现过。

────────── 输出格式 ──────────

{
  "question": "由该关系引申的新问题，≤35字，问号结尾",
  "question_detail": "问题详情说明，60–160字，讲清落在谁身上、为什么两篇回答都答不了、答它需要什么",
  "evidence": ["逐字摘自原文片段的依据1", "依据2"],
  "who_can_answer": "什么样的人有资格回答它，≤20字"
}"""

USER_QUESTION_TPL = """【原问题】{question}

{pack_a}

────────────────────────────

{pack_b}

────────────────────────────

【已判定的关系】
关系类型：{relation_type}
共同裁决对象：{shared_axis}
双方条件的重叠情形：{overlap_case}
为何不能同时接受：{incompatible_because}
关系说明：{relation_text}

请根据关系类型提出新问题：冲突类围绕「{overlap_case}」的具体取舍；
互补细化或共识支撑围绕「{shared_axis}」追问组合方法、适用边界或共同盲点。
记住引用铁律：evidence 必须逐字、连续地来自上面的原文片段。
只输出 JSON。"""


def build_relation_messages(question_title: str, pack_a: dict, pack_b: dict,
                           screen_signals: dict | None = None) -> list[dict]:
    """构造第一步（关系判定）的消息体。抽出来便于测试与复核实际输入。"""
    return [
        {"role": "system", "content": SYS_RELATION},
        {"role": "user", "content": USER_RELATION_TPL.format(
            question=question_title,
            pack_a=render_pack(pack_a, "回答一"),
            pack_b=render_pack(pack_b, "回答二"),
            screen=render_screen(screen_signals or {}) or "（无）",
        )},
    ]


def build_question_messages(question_title: str, pack_a: dict, pack_b: dict,
                            relation: dict) -> list[dict]:
    """构造第二步（提问）的消息体。"""
    return [
        {"role": "system", "content": SYS_QUESTION},
        {"role": "user", "content": USER_QUESTION_TPL.format(
            question=question_title,
            pack_a=render_pack(pack_a, "回答一"),
            pack_b=render_pack(pack_b, "回答二"),
            relation_type=relation.get("relation_type") or "",
            shared_axis=relation.get("shared_axis") or "（未给出）",
            overlap_case=relation.get("overlap_case") or "（未给出）",
            incompatible_because=relation.get("incompatible_because") or "（未给出）",
            relation_text=relation.get("relation_text") or "",
        )},
    ]


# 兼容旧调用方：一次性构造（已不用于主链路）。
def build_pair_messages(question_title: str, pack_a: dict, pack_b: dict) -> list[dict]:
    return build_relation_messages(question_title, pack_a, pack_b, None)


def _clip(text, limit):
    if not isinstance(text, str):
        return None
    t = text.strip()
    return t[:limit] if len(t) > limit else t


def _blank(value) -> bool:
    return not str(value or "").strip()


def _vague(value) -> bool:
    """举证字段是否只是把要求复述了一遍，等于没有举证。"""
    text = str(value or "").strip()
    return bool(_VAGUE_EVIDENCE.match(text))


def _evidence_count(data: dict) -> int:
    items = data.get("evidence")
    if not isinstance(items, list):
        return 0
    return len([item for item in items if isinstance(item, str) and item.strip()])


def _screen_supports_conflict(screen_signals: dict | None, rtype: str) -> str | None:
    """交叉核对：模型声称的强冲突必须有结构化字段支撑。

    预检算出的 conflict_signals 是客观可核的（原文排除表述、主张方向相反等）。
    模型判「直接对立」却一个信号都没命中时，多半是在硬凑，返回拒绝理由。
    """
    if rtype != "直接对立":
        return None
    codes = {
        item.get("code")
        for item in (screen_signals or {}).get("conflict_signals") or []
    }
    if codes & {"excludes_cross", "stance_opposed"}:
        return None
    return (
        "判为「直接对立」，但结构化字段里既没有一方排除对方做法的证据，"
        "两人的主张方向也不相反。正面对立必须有可核对的痕迹，否则视为过度解读。"
    )


def _question_detail(value, relation: dict) -> str:
    """问题详情说明。模型没写或写成空话时，用已通过举证校验的字段兜底。

    overlap_case 和 incompatible_because 在关系判定阶段已经过最小长度与笼统
    措辞校验，因此可以直接拼成一段可读的说明——它讲的正是「这问题落在谁身上、
    为什么两篇回答都答不了」，与本字段的要求一致。
    """
    text = str(value or "").strip()
    if len(text) >= MIN_QUESTION_DETAIL_LEN and not _vague(text):
        return text[:MAX_QUESTION_DETAIL_LEN]

    overlap = str(relation.get("overlap_case") or "").strip()
    incompatible = str(relation.get("incompatible_because") or "").strip()
    relation_text = str(relation.get("relation_text") or "").strip()
    if not overlap and not incompatible and relation_text:
        return (
            f"两篇回答的关联在于：{relation_text}"
            "这个问题希望进一步补上两边都没有说明的适用边界或取舍依据。"
        )[:MAX_QUESTION_DETAIL_LEN]
    if not overlap and not incompatible:
        return ""
    parts = []
    if overlap:
        parts.append(f"这个问题落在这样的情形上：{overlap}。")
    if incompatible:
        parts.append(f"两篇回答在这里会给出不同的做法——{incompatible}。")
    parts.append("两边都没有单独讲清这种情形下该怎么取舍，有过类似处境的人最有资格回答。")
    return "".join(parts)[:MAX_QUESTION_DETAIL_LEN]


def collide(
    question_title: str,
    pack_a: dict,
    pack_b: dict,
    sources: dict[str, str],
    verbose: bool = False,
    strict_tokens: bool = True,
    screen_signals: dict | None = None,
) -> dict:
    """执行一次碰撞（两步）。

    参数
        question_title : 原问题标题
        pack_a / pack_b: 两个节点的 ContextPack（必须来自不同回答）
        sources        : {answer_id: 清洗后原文}，用于 evidence 回查
        screen_signals : pair_screen 已算好的结构化比对结果

    返回统一结构：
        {
          "status": "published" | "no_result" | "blocked",
          "relation_type", "relation_text", "question", "question_detail",
          "shared_axis", "overlap_case", "incompatible_because", "dispute_scale",
          "evidence_located": [...], "who_can_answer",
          "reason": 未通过时的原因,
        }

    说明：本函数不抛异常给调用方，所有失败都转成 status=blocked，
    以保证前端拿到的永远是可渲染的结构。
    """
    out = {
        "status": "blocked",
        "relation_type": None,
        "relation_text": None,
        "question": None,
        "question_detail": None,
        "shared_axis": None,
        "overlap_case": None,
        "incompatible_because": None,
        "dispute_scale": None,
        "evidence_located": [],
        "who_can_answer": None,
        "reason": "",
        "_raw": None,
    }

    # ---------------- 第一步：关系判定 ----------------
    try:
        raw_relation = call_llm_resilient(
            build_relation_messages(question_title, pack_a, pack_b, screen_signals), verbose=verbose
        )
    except Exception as exc:  # 网络/额度问题：如实上报，不伪造结果
        out["reason"] = f"模型调用失败：{exc}"
        return out

    out["_raw"] = raw_relation
    data = parse_json(raw_relation)
    if not isinstance(data, dict):
        out["reason"] = "关系判定输出无法解析为 JSON"
        return out

    rtype = (data.get("relation_type") or "").strip()
    if rtype not in RELATION_TYPES:
        # 容错：模型偶尔自创近义词，归一到最接近的合法值，归不上就当无结果
        rtype = next((t for t in RELATION_TYPES if t in rtype), NO_RESULT)

    out["relation_type"] = rtype
    out["relation_text"] = _clip(data.get("relation_text"), 360)
    out["shared_axis"] = _clip(data.get("shared_axis"), 60)
    out["overlap_case"] = _clip(data.get("overlap_case"), 120)
    out["incompatible_because"] = _clip(data.get("incompatible_because"), 200)
    scale = (data.get("dispute_scale") or "").strip()
    out["dispute_scale"] = scale if scale in {"substantive", "superficial"} else None

    # ---- 真正无关的关系不产出问题；互补与共识继续寻找延展问题 ----
    if rtype in NON_PRODUCTIVE:
        out["status"] = "no_result"
        default_reason = {
            COMPLEMENTARY: "一方是另一方在更窄条件下的具体做法，两者相容，碰不出真分歧",
            CONSENSUS: "两个观点表面像分歧，实则共享同一个判断，碰撞只会得到已有共识",
        }.get(rtype, "这两个观点裁决的不是同一件事")
        out["reason"] = out["relation_text"] or default_reason
        return out

    if rtype in RELATED_TYPES:
        missing = []
        if _blank(out["shared_axis"]) or len(out["shared_axis"] or "") < MIN_SHARED_AXIS_LEN:
            missing.append("共同对象")
        if _evidence_count(data) < MIN_RELATION_EVIDENCE:
            missing.append("双方原文依据")
        if missing:
            out["status"] = "no_result"
            out["reason"] = (
                f"判为「{rtype}」但缺少{'、'.join(missing)}，目前不足以从关联继续提问。"
            )
            return out

    # ---- 举证责任：冲突类必须三项齐全，且必须是真正的举证而非复述要求 ----
    if rtype in CONFLICT_TYPES:
        missing = [
            name for name, value in (
                ("共同裁决对象", out["shared_axis"]),
                ("条件重叠情形", out["overlap_case"]),
                ("不相容理由", out["incompatible_because"]),
            ) if _blank(value)
        ]
        if missing:
            out["status"] = "no_result"
            out["reason"] = (
                f"判为「{rtype}」但没能完成举证（缺少：{'、'.join(missing)}）。"
                "写不出同时符合双方条件且结论冲突的具体情形，说明两者并不真正对立。"
            )
            return out

        # 举证质量：太短或只是把要求复述一遍，都等于没有举证。
        thin = []
        for name, value, limit in (
            ("共同裁决对象", out["shared_axis"], MIN_SHARED_AXIS_LEN),
            ("条件重叠情形", out["overlap_case"], MIN_OVERLAP_CASE_LEN),
            ("不相容理由", out["incompatible_because"], MIN_INCOMPATIBLE_LEN),
        ):
            if _vague(value):
                thin.append(f"{name}（过于笼统）")
            elif len(value) < limit:
                thin.append(f"{name}（仅 {len(value)} 字，要求 ≥{limit} 字）")
        if thin:
            out["status"] = "no_result"
            out["reason"] = (
                f"判为「{rtype}」，但举证不实：{'、'.join(thin)}。"
                "说不出那个具体情形和具体冲突点，就不构成值得讨论的分歧。"
            )
            return out

        # 声称冲突至少要给两条原文依据，单条依据撑不起一个对立判断。
        evidence_count = _evidence_count(data)
        if evidence_count < MIN_RELATION_EVIDENCE:
            out["status"] = "no_result"
            out["reason"] = (
                f"判为「{rtype}」却只给了 {evidence_count} 条原文依据"
                f"（要求 ≥{MIN_RELATION_EVIDENCE} 条，双方各至少一条）。"
                "对立需要双方原文同时支撑，否则只是单方面推测。"
            )
            return out

        # 与预检的客观信号交叉核对，挡掉「硬凑正面对立」。
        conflict_mismatch = _screen_supports_conflict(screen_signals, rtype)
        if conflict_mismatch:
            out["status"] = "no_result"
            out["reason"] = conflict_mismatch
            return out

    # ---- 分歧强度闸门：只约束冲突类；互补/共识的价值不依赖对立强度 ----
    if rtype in CONFLICT_TYPES and out["dispute_scale"] != "substantive":
        out["status"] = "no_result"
        out["reason"] = (
            "两人的差异只在强度、措辞或侧重上，实际主张一致，"
            "碰撞产出的问题不会有真正的讨论空间。"
            if out["dispute_scale"] == "superficial"
            else "模型没有明确认定这是实质分歧（dispute_scale 缺失或非法），按无结果处理。"
        )
        return out

    # ---- 关系说明长度校验 ----
    relation_text = out["relation_text"] or ""
    if len(relation_text) < MIN_RELATION_TEXT_LEN:
        out["status"] = "blocked"
        out["reason"] = f"AI 分析过短（{len(relation_text)} 字，要求 ≥{MIN_RELATION_TEXT_LEN} 字）"
        return out

    # ---- 关系判定自带的 evidence 先回查一次，挡掉编造的关系依据 ----
    relation_ok, relation_enriched, relation_reason = validate_question(
        {"question": "占位？", "evidence": data.get("evidence")},
        sources,
        strict_tokens=False,
    )
    if not relation_ok:
        out["status"] = "blocked"
        out["reason"] = f"关系依据无法回原文核对：{relation_reason}"
        return out

    # ---------------- 第二步：提问 ----------------
    try:
        raw_question = call_llm_resilient(
            build_question_messages(question_title, pack_a, pack_b, out), verbose=verbose
        )
    except Exception as exc:
        out["reason"] = f"提问阶段模型调用失败：{exc}"
        return out

    question_data = parse_json(raw_question)
    if not isinstance(question_data, dict) or not question_data.get("question"):
        out["status"] = "blocked"
        out["reason"] = "提问阶段没有产出合法问句"
        return out

    out["who_can_answer"] = _clip(question_data.get("who_can_answer"), 40)
    out["question_detail"] = _question_detail(question_data.get("question_detail"), out)

    # ---- evidence 回查 + 具体元素扫描（零 LLM 调用）----
    passed, enriched, reason = validate_question(
        {"question": question_data.get("question"), "evidence": question_data.get("evidence")},
        sources,
        strict_tokens=strict_tokens,
    )
    out["reason"] = reason
    if not passed:
        out["status"] = "blocked"
        return out

    out["status"] = "published"
    out["question"] = enriched.get("question")
    out["evidence_located"] = (
        enriched.get("evidence_located", []) + relation_enriched.get("evidence_located", [])
    )
    out["warnings"] = enriched.get("warnings", [])
    return out
