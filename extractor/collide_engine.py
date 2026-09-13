# -*- coding: utf-8 -*-
"""碰撞引擎：两个节点 → 关系说明 + 新问题。

本模块对应 PRD v1.0 的链路第 ⑤⑥ 步，是前端碰撞 API 的实现内核。

与二审 `run_question_pipeline.py` 的差异（**本版定稿的三项**）：

1. **产物是两段而非一段**：
       关系说明（这两个节点是什么关系）+ 新问题（由该关系引申）
   二审只产出问题，关系判断隐含在策略名里，用户看不到。

2. **动作完全内化**：
   不再由用户选择「交锋 / 合流」，也不再由调用方指定提问策略。
   关系类型由模型自行判定并输出，作为分析结果呈现，而非作为选项输入。

   依据：实测 16 次调用（8 动作 × 2 方向）只产出 13 种结果，
   「算法岗的工程化趋势削弱了其长期优势」一句横跨交锋/归因/验真出现 4 次。
   动作多不产生差异；且主客顺序实验中设计者 8 个预测错了 5 个，
   说明动作行为无法靠设计推演，每个动作都是必须实测的负债。

3. **允许无结果是一等公民**：
   relation_type = "无有效关系" 时返回 no_result，不产生公开节点，
   且**不计为技术失败**。语义塌缩现象证明：有些节点对就是不值得碰。

闸门沿用 `question_validator.validate_question`（零 LLM 调用，阈值 0.82）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from run_extract import call_llm_resilient, parse_json
from context_pack import build_context_pack, render_pack
from question_validator import validate_question

# ---------------------------------------------------------------------------
# 关系类型。由模型判定，不由用户选择。
# 取值来自二审实测中真实出现过的配对性质（见 实测报告_q2q6_全链路.md §6）。
# ---------------------------------------------------------------------------
RELATION_TYPES = [
    "归因冲突",   # 把同一现象归到互斥的原因上
    "机制冲突",   # 对「怎么运作的」给出互斥描述
    "直接对立",   # 正面相反的主张
    "元层冲突",   # 一方给答案，一方否认存在答案
    "条件分歧",   # 结论不同源于适用前提不同
    "共识支撑",   # 表面不同，实则共享同一判断
    "无有效关系",  # 讨论对象差太远，碰不出东西
]

NO_RESULT = "无有效关系"

SYS = """你是一个「提问者」。这是知乎——一个从问题出发的平台。

给你同一个问题下**两篇不同回答**中各一个观点节点，以及它们各自的**原文片段**。

你要做两件事：
一、判断这两个观点是什么关系（关系说明）
二、由这个关系引申出一个新的、具体的问题（新问题）

产物的价值不在于总结谁对谁错，而在于**让读过这两篇回答的人产生继续讨论的欲望**。

────────────────── 铁律 ──────────────────

1. 只输出 JSON，不要任何解释，不要 markdown 围栏。

2.【关系判断】relation_type 必须从以下取值中选一个：
   - 归因冲突：把同一现象归到互斥的原因上
   - 机制冲突：对「它是怎么运作的」给出互斥描述
   - 直接对立：正面相反的主张
   - 元层冲突：一方给出确定答案，一方否认存在答案
   - 条件分歧：结论不同，根源是各自预设的适用前提不同
   - 共识支撑：表面像分歧，实则共享同一个未言明的判断
   - 无有效关系：两者讨论的根本不是一回事

3.【关系说明】relation_text，20–120 字。
   写清楚**分歧点或共识点具体落在哪里**，而不是复述两个观点。
   不要裁定谁对谁错——你的角色是指出关系，不是当裁判。
   反面例子（太空泛，不要这样写）：「两人观点不同，各有道理。」
   正面例子：「两人把同一现象归到互斥的原因上：一方归于硬件算力，
   一方归于架构设计。分歧点在于架构优势能否脱离算力规模独立成立。」

4.【新问题】question，必须是一个问句，以问号结尾，**≤35 字，越短越有力**。
   - 不要提原问题的同义改写。新问题必须是原问题回答不了、
     但读完这两篇回答后才浮现出来的那个问题。
   - 不要提泛泛的问题（「你怎么看」「如何看待」「有什么影响」）。
   - 自检：把问题拿给读完这两篇回答的人看，他会想打字回复吗？
     如果他只会点头或摇头，说明问题不好。

5.【引用铁律 —— 最重要的一条】
   你的关系说明和问题里出现的每一个具体元素——数字、专有名词、
   身份标签、时间点、场景词——都必须能在我给你的**原文片段**中找到出处。

   你必须在 evidence 数组中列出你依据的原文片段（逐字摘录，每条 10–60 字，最多 3 条）。
   每条 evidence 必须是原文中**连续的一段话**，不得把不相邻的两句拼接在一起，
   不得加省略号、不得跨段落拼接。
   系统会把 evidence 拿回原文做字符串校验，对不上的整条产物会被丢弃。

   特别警告：不要引入原文没有的社会情绪词。
   典型的编造：「35岁」「转行」「被裁员」「内卷」「焦虑」「中年危机」——
   除非原文真的出现了这些词，否则一律不许用。
   这类词很有煽动性，但它们不来自这两篇回答，属于伪造论据。

6.【允许失败，不允许编造】
   如果这两个观点讨论的根本不是一回事，或你发现想写的内容在原文里找不到支撑，
   请如实输出：
   {"relation_type": "无有效关系", "relation_text": "简述为什么碰不出来", "question": null}
   这是**合法且受欢迎的结果**，不是失败。硬凑一个平庸问题才是失败。

────────────────── 输出格式 ──────────────────

{
  "relation_type": "上述七个取值之一",
  "relation_text": "关系说明，20–120字",
  "question": "由该关系引申的新问题，≤35字，问号结尾",
  "evidence": ["逐字摘自原文片段的依据1", "依据2"],
  "who_can_answer": "什么样的人有资格回答它，≤20字"
}"""

USER_TPL = """【原问题】{question}

{pack_a}

────────────────────────────

{pack_b}

────────────────────────────

请判断这两个观点的关系，并由此提出一个新问题。
记住引用铁律：evidence 必须逐字、连续地来自上面的原文片段。
如果两者讨论的不是一回事，请如实返回「无有效关系」。
只输出 JSON。"""


def build_pair_messages(question_title: str, pack_a: dict, pack_b: dict) -> list[dict]:
    """构造碰撞调用的消息体。抽出来便于测试与复核实际输入。"""
    return [
        {"role": "system", "content": SYS},
        {"role": "user", "content": USER_TPL.format(
            question=question_title,
            pack_a=render_pack(pack_a, "回答一"),
            pack_b=render_pack(pack_b, "回答二"),
        )},
    ]


def _clip(text, limit):
    if not isinstance(text, str):
        return None
    t = text.strip()
    return t[:limit] if len(t) > limit else t


def collide(
    question_title: str,
    pack_a: dict,
    pack_b: dict,
    sources: dict[str, str],
    verbose: bool = False,
    strict_tokens: bool = True,
) -> dict:
    """执行一次碰撞。

    参数
        question_title : 原问题标题
        pack_a / pack_b: 两个节点的 ContextPack（必须来自不同回答）
        sources        : {answer_id: 清洗后原文}，用于 evidence 回查

    返回统一结构：
        {
          "status": "published" | "no_result" | "blocked",
          "relation_type", "relation_text", "question",
          "evidence_located": [...], "who_can_answer",
          "reason": 未通过时的原因,
          "_raw": 模型原始输出
        }

    说明：本函数不抛异常给调用方，所有失败都转成 status=blocked，
    以保证前端拿到的永远是可渲染的结构。
    """
    out = {
        "status": "blocked",
        "relation_type": None,
        "relation_text": None,
        "question": None,
        "evidence_located": [],
        "who_can_answer": None,
        "reason": "",
        "_raw": None,
    }

    msgs = build_pair_messages(question_title, pack_a, pack_b)
    try:
        raw = call_llm_resilient(msgs, verbose=verbose)
    except Exception as exc:  # 网络/额度问题：如实上报，不伪造结果
        out["reason"] = f"模型调用失败：{exc}"
        return out

    out["_raw"] = raw
    data = parse_json(raw)
    if not isinstance(data, dict):
        out["reason"] = "模型输出无法解析为 JSON"
        return out

    rtype = (data.get("relation_type") or "").strip()
    if rtype not in RELATION_TYPES:
        # 容错：模型偶尔会自创近义词，归一到最接近的合法值，归不上就当无结果
        rtype = next((t for t in RELATION_TYPES if t in rtype), NO_RESULT)

    out["relation_type"] = rtype
    out["relation_text"] = _clip(data.get("relation_text"), 200)
    out["who_can_answer"] = _clip(data.get("who_can_answer"), 40)

    # ---- 无有效关系：合法结果，不是失败 ----
    if rtype == NO_RESULT or not data.get("question"):
        out["status"] = "no_result"
        out["reason"] = out["relation_text"] or "这两个观点讨论的不是同一件事"
        return out

    # ---- AI 复审：evidence 回查 + 具体元素扫描（零 LLM 调用）----
    passed, enriched, reason = validate_question(
        {"question": data.get("question"), "evidence": data.get("evidence")},
        sources,
        strict_tokens=strict_tokens,
    )
    out["reason"] = reason
    if not passed:
        out["status"] = "blocked"
        return out

    # ---- 关系说明长度校验（PRD §7 关卡五）----
    rt = out["relation_text"] or ""
    if len(rt) < 20:
        out["status"] = "blocked"
        out["reason"] = f"关系说明过短（{len(rt)} 字，要求 ≥20 字）"
        return out

    out["status"] = "published"
    out["question"] = enriched.get("question")
    out["evidence_located"] = enriched.get("evidence_located", [])
    out["warnings"] = enriched.get("warnings", [])
    return out
