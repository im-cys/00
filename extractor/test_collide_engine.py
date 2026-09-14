# -*- coding: utf-8 -*-
"""碰撞引擎闸门测试。

全部用 mock 替掉 call_llm_resilient，零网络调用，只验证闸门逻辑本身。

本文件的存在理由：v4 之前引擎侧只有「三项举证非空」和「superficial 拦截」
两道实质闸门，通过率过高。这里逐项锁住收紧后的行为，防止回退。

最重要的回归项是 test_consensus_support_is_not_productive：
「共识支撑」曾同时不在 NON_PRODUCTIVE 和 CONFLICT_TYPES 里，于是它既不走
no_result、也不需要举证，成了绕过全部实质闸门的直通车——而它的定义恰恰是
「表面像分歧，实则共享同一判断」，也就是最典型的无价值碰撞。
"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import collide_engine  # noqa: E402
from collide_engine import (  # noqa: E402
    CONSENSUS,
    MAX_QUESTION_DETAIL_LEN,
    MIN_RELATION_EVIDENCE,
    collide,
)

SOURCE_A = (
    "我认为有家庭负担的人也该果断辞职创业，机会窗口不会等你准备好。"
    "拖到什么都齐备的那天，能做的事情早就被别人做完了。"
)
SOURCE_B = (
    "如果你上有老下有小，我不建议你冲动辞职，先用副业把想法验证一遍。"
    "房贷和孩子的开销不该由一次赌博来承担。"
)
SOURCES = {"10001-01": SOURCE_A, "10001-02": SOURCE_B}

# 长度须 ≥ MIN_RELATION_TEXT_LEN(60)
GOOD_RELATION_TEXT = (
    "两个回答都在判断有家庭负担的人该不该裸辞，但把不同的东西放在了首位："
    "一方看重机会窗口的时效，认为等准备齐全就来不及了；另一方看重家庭现金流的安全边界，"
    "主张先用副业验证。对同一个有房贷和孩子的人来说，这两条路会导向完全不同的当下动作。"
)
GOOD_EVIDENCE = [
    "我认为有家庭负担的人也该果断辞职创业，机会窗口不会等你准备好。",
    "如果你上有老下有小，我不建议你冲动辞职，先用副业把想法验证一遍。",
]


def pack(answer_id, author, statement, axis, stance, source, **kwargs):
    """最小可渲染的 ContextPack。字段对齐 context_pack.render_pack 的读取。"""
    return {
        "node_id": f"{answer_id}_c1",
        "answer_id": answer_id,
        "author": author,
        "statement": statement,
        "axis": axis,
        "stance": stance,
        "conditions": kwargs.pop("conditions", {"audience": ["上有老下有小"], "stage": [], "premise": []}),
        "excludes": kwargs.pop("excludes", []),
        "strength": kwargs.pop("strength", None),
        "tradeoff": None,
        "not_applicable": None,
        "collision_role": "recommendation",
        "quote": statement,
        "char_offset": 0,
        "group": {"group_id": f"{answer_id}_root", "title": "核心观点", "summary": ""},
        "siblings": [],
        "context_window": {"start": 0, "end": len(source), "text": source},
        "condition_hints": [],
        "ancestor_path": [],
        "reason_summary": "",
        "supports": [],
        **kwargs,
    }


PACK_A = pack("10001-01", "甲", "我认为有家庭负担的人也该果断辞职创业，机会窗口不会等你准备好",
              "有家庭负担的人该不该裸辞", "should", SOURCE_A)
PACK_B = pack("10001-02", "乙", "如果你上有老下有小，我不建议你冲动辞职，先用副业把想法验证一遍",
              "有家庭负担的人该不该裸辞", "should_not", SOURCE_B)

# pair_screen 对上面这对节点会给出的信号（stance 相反 → stance_opposed）
SCREEN_OPPOSED = {
    "axis": {"level": "exact", "exact": True, "aligned": True},
    "stance": {"a": "should", "b": "should_not", "conflict_possible": True},
    "conditions": {"per_key": {"audience": "overlap:上有"}, "exclusive_keys": [], "both_stated_keys": 1},
    "similarity": {"value": 0.2, "limit": 0.5},
    "excludes_cross_hit": [],
    "conflict_signals": [{"code": "stance_opposed", "detail": "一方主张该做、另一方主张不该做"}],
}
# 没有任何强冲突信号的场景（用于交叉核对闸门）
SCREEN_WEAK = {
    **SCREEN_OPPOSED,
    "stance": {"a": "should", "b": "conditional", "conflict_possible": True},
    "conflict_signals": [
        {"code": "same_axis_divergent_claims", "detail": "同一争议对象下两个主张说法差异明显"}
    ],
}


def relation(**overrides):
    """一份能通过全部闸门的关系判定输出，按需覆盖单个字段。"""
    payload = {
        "relation_type": "直接对立",
        "dispute_scale": "substantive",
        "shared_axis": "有家庭负担的人该不该裸辞创业",
        "overlap_case": "一个有房贷和两个孩子、但现在工作很不开心的三十多岁的人",
        "incompatible_because": "照甲立刻辞职就拿不到乙说的副业验证期，断供风险要由家人承担",
        "relation_text": GOOD_RELATION_TEXT,
        "evidence": list(GOOD_EVIDENCE),
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


GOOD_QUESTION_DETAIL = (
    "一个有房贷和两个孩子、又对现在工作不满的人，照甲的说法该立刻辞职抓住窗口，"
    "照乙的说法该先用副业验证。两条路的现金流风险完全不同，"
    "而两篇回答都没说清这种情形下该怎么取舍。"
)


def question(**overrides):
    """提问阶段输出。默认不带 question_detail，用于覆盖兜底路径。"""
    payload = {
        "question": "有房贷和孩子时，该先辞职还是先用副业验证？",
        "evidence": list(GOOD_EVIDENCE),
        "who_can_answer": "带着家庭负担做过转型的人",
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


QUESTION_OK = question()


def run(relation_raw, question_raw=QUESTION_OK, screen=SCREEN_OPPOSED):
    """跑一次 collide，模型调用全部由 mock 提供。"""
    with patch.object(collide_engine, "call_llm_resilient",
                      side_effect=[relation_raw, question_raw]):
        return collide("该不该辞职创业？", PACK_A, PACK_B, SOURCES,
                       screen_signals=screen)


class CollideGateTest(unittest.TestCase):

    def test_fully_evidenced_conflict_is_published(self):
        """基准线：举证齐全、强度明确、依据可回查时正常产出问题。"""
        out = run(relation())
        self.assertEqual(out["status"], "published", out["reason"])
        self.assertEqual(out["relation_type"], "直接对立")
        self.assertEqual(out["dispute_scale"], "substantive")
        self.assertTrue(out["question"])
        self.assertTrue(out["evidence_located"])

    # ---------------- 问题详情说明 ----------------

    def test_question_detail_from_model_is_kept(self):
        """模型写了合格的详情说明时逐字保留。"""
        out = run(relation(), question(question_detail=GOOD_QUESTION_DETAIL))
        self.assertEqual(out["status"], "published", out["reason"])
        self.assertEqual(out["question_detail"], GOOD_QUESTION_DETAIL)

    def test_missing_question_detail_falls_back_to_evidenced_fields(self):
        """模型漏写时，用已通过举证校验的字段拼出说明，不留空白。

        overlap_case 与 incompatible_because 在关系判定阶段已过最小长度与
        笼统措辞校验，因此拿来兜底是安全的——它们讲的正是「这问题落在谁身上、
        为什么两篇回答都答不了」。
        """
        out = run(relation(), question())
        self.assertEqual(out["status"], "published", out["reason"])
        detail = out["question_detail"]
        self.assertTrue(detail)
        self.assertIn("有房贷和两个孩子", detail)      # 来自 overlap_case
        self.assertIn("副业验证期", detail)            # 来自 incompatible_because
        self.assertIn("最有资格回答", detail)

    def test_vague_question_detail_falls_back(self):
        """空话不算说明，走兜底而不是原样展示给读者。"""
        out = run(relation(), question(question_detail="暂无"))
        self.assertEqual(out["status"], "published", out["reason"])
        self.assertNotEqual(out["question_detail"], "暂无")
        self.assertIn("有房贷和两个孩子", out["question_detail"])

    def test_too_short_question_detail_falls_back(self):
        out = run(relation(), question(question_detail="这个问题值得深入探讨。"))
        self.assertEqual(out["status"], "published", out["reason"])
        self.assertIn("有房贷和两个孩子", out["question_detail"])

    def test_question_detail_is_length_capped(self):
        out = run(relation(), question(question_detail="很" * 400))
        self.assertEqual(out["status"], "published", out["reason"])
        self.assertLessEqual(len(out["question_detail"]), MAX_QUESTION_DETAIL_LEN)

    # ---------------- 不产出问题的关系 ----------------

    def test_consensus_support_is_not_productive(self):
        """回归：共识支撑必须走 no_result，不能绕过实质闸门直接 published。"""
        out = run(relation(relation_type=CONSENSUS))
        self.assertEqual(out["status"], "no_result")
        self.assertEqual(out["relation_type"], CONSENSUS)
        self.assertIsNone(out["question"])

    def test_complementary_refinement_is_not_productive(self):
        out = run(relation(relation_type="互补细化"))
        self.assertEqual(out["status"], "no_result")
        self.assertIsNone(out["question"])

    def test_no_relation_is_not_productive(self):
        out = run(relation(relation_type="无有效关系"))
        self.assertEqual(out["status"], "no_result")
        self.assertIsNone(out["question"])

    # ---------------- 举证质量 ----------------

    def test_missing_evidence_field_is_rejected(self):
        out = run(relation(overlap_case=""))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("没能完成举证", out["reason"])
        self.assertIn("条件重叠情形", out["reason"])

    def test_vague_overlap_case_is_rejected(self):
        """「这个人」只是把要求复述了一遍，不算举证。"""
        out = run(relation(overlap_case="这个人"))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("举证不实", out["reason"])
        self.assertIn("过于笼统", out["reason"])

    def test_vague_incompatible_reason_is_rejected(self):
        out = run(relation(incompatible_because="两者不能同时接受"))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("举证不实", out["reason"])

    def test_too_short_incompatible_reason_is_rejected(self):
        out = run(relation(incompatible_because="会冲突"))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("举证不实", out["reason"])

    def test_single_evidence_item_is_rejected_for_conflict(self):
        """声称对立至少要两条依据，双方各出一条。"""
        out = run(relation(evidence=[GOOD_EVIDENCE[0]]))
        self.assertEqual(out["status"], "no_result")
        self.assertIn(f"≥{MIN_RELATION_EVIDENCE} 条", out["reason"])

    # ---------------- 分歧强度白名单 ----------------

    def test_superficial_dispute_is_rejected(self):
        out = run(relation(dispute_scale="superficial"))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("只在强度、措辞或侧重上", out["reason"])

    def test_missing_dispute_scale_is_rejected(self):
        """白名单：漏填不再默认放行。"""
        out = run(relation(dispute_scale=""))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("没有明确认定这是实质分歧", out["reason"])

    def test_illegal_dispute_scale_is_rejected(self):
        out = run(relation(dispute_scale="maybe"))
        self.assertEqual(out["status"], "no_result")
        self.assertIn("没有明确认定这是实质分歧", out["reason"])

    # ---------------- 与预检交叉核对 ----------------

    def test_direct_opposition_needs_objective_screen_signal(self):
        """判「直接对立」但结构化字段核不上，视为过度解读。"""
        out = run(relation(), screen=SCREEN_WEAK)
        self.assertEqual(out["status"], "no_result")
        self.assertIn("正面对立必须有可核对的痕迹", out["reason"])

    def test_other_conflict_types_skip_the_opposition_cross_check(self):
        """交叉核对只针对「直接对立」，条件分歧等不受此限。"""
        out = run(relation(relation_type="条件分歧"), screen=SCREEN_WEAK)
        self.assertEqual(out["status"], "published", out["reason"])

    # ---------------- 其他 ----------------

    def test_short_relation_text_is_blocked(self):
        out = run(relation(relation_text="两人观点不同，各有道理。"))
        self.assertEqual(out["status"], "blocked")
        self.assertIn("AI 分析过短", out["reason"])

    def test_fabricated_relation_evidence_is_blocked(self):
        out = run(relation(evidence=["原文里根本没有这句话，是我编的",
                                     "这句同样不存在于任何一篇回答"]))
        self.assertEqual(out["status"], "blocked")
        self.assertIn("关系依据无法回原文核对", out["reason"])

    def test_unparsable_relation_output_is_blocked(self):
        out = run("这不是 JSON")
        self.assertEqual(out["status"], "blocked")
        self.assertIn("无法解析", out["reason"])


if __name__ == "__main__":
    unittest.main()
