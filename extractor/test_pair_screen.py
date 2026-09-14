# -*- coding: utf-8 -*-
"""碰撞预检闸门测试。

回归基准是一次真实误判：
    A「30岁的时候，可能你会面临一次创业或者继续打工的选择」
    B「有家庭、上有老下有小的，极度不建议冲动辞职，可以把想做的事当副业」
旧链路判成「条件分歧」并生成了有漏洞的问题。四个维度差异都很大，
但真实关系是 B 属于 A 那个分岔口的一个具体解法，两者相容。新版允许它进入
关联判断，但必须保持中立，不能仅凭措辞差异强行定性为冲突。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pair_screen import screen_pair, render_screen  # noqa: E402


def node(statement, axis, stance, audience=None, stage=None, premise=None, excludes=None, **kwargs):
    return {
        "statement": statement,
        "axis": axis,
        "stance": stance,
        "conditions": {
            "audience": audience or [],
            "stage": stage or [],
            "premise": premise or [],
        },
        "excludes": excludes or [],
        **kwargs,
    }


class PairScreenTest(unittest.TestCase):
    def test_descriptive_and_prescriptive_can_form_a_related_question(self):
        """描述现象与行动建议有共同对象时，可以形成解释或边界问题。

        这里两个 axis 取相同值，因为 v2.4 的 knownAxes 机制会让同一问题下的
        回答复用同一个争议对象说法。也就是说 C1（对象对齐）会放行，
        必须由 C3（裁决平面）拦住——这正是这对节点被误判的地方。
        """
        a = node(
            "30岁前后你大概会碰上一次要不要出来自己干的选择，这个岔路口躲不掉",
            "30岁前后该不该辞职创业", "descriptive",
            stage=["30岁前后"],
        )
        b = node(
            "如果你上有老下有小，我不建议你冲动辞职，先把想做的事放在副业里试",
            "30岁前后该不该辞职创业", "should_not",
            audience=["上有老下有小"], excludes=["冲动辞职从零开始"],
        )
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertEqual(result["signals"]["stance"]["relation_hint"],
                         "description_and_recommendation")
        self.assertTrue(result["signals"]["axis"]["exact"])
        self.assertFalse(result["signals"]["stance"]["conflict_possible"])

    def test_axis_mismatch_is_rejected(self):
        a = node("我更看重专业留给你的转身空间，而不是当下的收入天花板",
                 "选专业时该优先看什么", "should")
        b = node("周末我一般带孩子去公园散步，这比在家躺着更能恢复精力",
                 "周末该怎么安排休息", "should")
        result = screen_pair(a, b)
        self.assertFalse(result["collidable"])
        self.assertEqual(result["code"], "axis_mismatch")

    def test_different_conditions_are_kept_as_relation_context(self):
        """同一对象下的人群差异可以帮助追问适用边界，不在预检层误杀。"""
        a = node("刚毕业的话我建议你先进大厂把基本功打扎实，别急着做选择",
                 "该不该裸辞创业", "should",
                 audience=["应届毕业生"])
        b = node("如果你已经是退休返聘的状态，我觉得完全可以放手去试自己的项目",
                 "该不该裸辞创业", "should",
                 audience=["退休返聘人员"])
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertIn("audience", result["signals"]["conditions"]["exclusive_keys"])
        self.assertEqual(result["signals"]["conditions"]["relation_hint"],
                         "different_conditions")

    def test_direct_conflict_candidate_passes_with_excludes_hit(self):
        """一方的主张正好落在另一方明确排除的做法里 → 最强的真冲突信号。"""
        a = node("我认为有家庭负担的人也该果断辞职创业，机会窗口不会等你准备好",
                 "有家庭负担的人该不该裸辞", "should",
                 audience=["上有老下有小"])
        b = node("如果你上有老下有小，我不建议你冲动辞职，先把想做的事放在副业里试",
                 "有家庭负担的人该不该裸辞", "should_not",
                 audience=["上有老下有小"], excludes=["辞职创业"])
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertEqual(result["code"], "direct_conflict_candidate")
        self.assertTrue(result["signals"]["excludes_cross_hit"])
        self.assertTrue(result["signals"]["axis"]["exact"])

    def test_empty_conditions_count_as_universal(self):
        """一方未限定条件表示普遍适用，不应被判成条件互斥。"""
        a = node("我认为选专业该优先看转身空间，而不是当下的收入天花板",
                 "选专业时该优先看什么", "should")
        b = node("如果你家里经济压力大，我觉得选专业时起薪应该排在第一位",
                 "选专业时该优先看什么", "should",
                 premise=["家里经济压力大"])
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertEqual(result["signals"]["conditions"]["per_key"]["audience"], "universal")

    def test_axis_missing_falls_back_to_word_overlap(self):
        """axis 漏填时退回词重叠，不能因为一个字段缺失就误杀配对。"""
        a = node("我认为方向没定的人该优先看专业的转身空间，而不是收入天花板",
                 "", "should")
        b = node("我觉得选专业还是该看收入天花板，转身空间是想太多了",
                 "", "should")
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertFalse(result["signals"]["axis"]["exact"])
        self.assertTrue(result["signals"]["axis"]["shared"])

    def test_render_screen_states_absence_of_excludes(self):
        a = node("我认为选专业该优先看转身空间", "选专业时该优先看什么", "should")
        b = node("我觉得选专业该优先看起薪", "选专业时该优先看什么", "should")
        text = render_screen(screen_pair(a, b)["signals"])
        self.assertIn("争议对象已对齐", text)
        self.assertIn("没有在原文中明确排除", text)
        self.assertIn("互补、适用边界或共同盲点", text)

    # ------------------------------------------------------------------
    # v2 收紧：C5 相似度闸门 与 C4 分歧信号闸门
    # ------------------------------------------------------------------

    def test_near_duplicate_claims_are_rejected_as_consensus(self):
        """C5：两个观点说的其实是同一件事，碰撞只会得到已有共识。"""
        a = node("我认为选专业该优先看转身空间，而不是当下收入",
                 "选专业时该优先看什么", "should")
        b = node("我认为选专业该优先看转身空间和它的方向",
                 "选专业时该优先看什么", "should")
        result = screen_pair(a, b)
        self.assertFalse(result["collidable"])
        self.assertEqual(result["code"], "claims_too_similar")
        similarity = result["signals"]["similarity"]
        self.assertGreater(similarity["value"], similarity["limit"])

    def test_same_topic_without_conflict_signal_is_a_related_candidate(self):
        """同一对象下各说一面也可能形成互补或共同盲点问题。

        这是本次收紧的主要目标。旧版只要没被 C1～C3 否证就放行，
        等于默认「分歧存在」；实际上这类配对最常见，且多数无价值。
        """
        a = node("我觉得选专业要把长期收益放在热度前面", "", "should")
        b = node("长期收益和当下热度之间我选前面那个", "", "should")
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertEqual(result["code"], "related_candidate")
        self.assertEqual(result["signals"]["conflict_signals"], [])

    def test_weak_divergence_signal_alone_is_not_a_conflict_candidate(self):
        """强弱信号分级：只靠相似度推出的「同轴异答」不足以定性为冲突。

        这两句都主张「该优先看某个指标」，只是指标不同，没有排除表述、
        没有立场对立、也不是绝对 vs 条件。它确实可能是冲突，也可能是互补，
        所以预检必须保持中立：标为 related_candidate，并在给模型的提示里
        保留互补/边界/盲点这条路，由模型结合原文定性。
        """
        a = node("我认为选专业该优先看转身空间", "选专业时该优先看什么", "should")
        b = node("我觉得选专业该优先看起薪", "选专业时该优先看什么", "should")
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        codes = {item["code"] for item in result["signals"]["conflict_signals"]}
        self.assertEqual(codes, {"same_axis_divergent_claims"})
        self.assertEqual(result["code"], "related_candidate")
        self.assertEqual(result["signals"]["relation_basis"], "complementary_perspectives")

    def test_strong_signal_is_a_conflict_candidate(self):
        """对照组：命中强信号（立场对立）时才定性为冲突候选。"""
        a = node("我认为有家庭负担的人也该果断辞职创业", "有家庭负担的人该不该裸辞",
                 "should", audience=["上有老下有小"])
        b = node("如果你上有老下有小，我不建议辞职，先用副业验证",
                 "有家庭负担的人该不该裸辞", "should_not", audience=["上有老下有小"])
        result = screen_pair(a, b)
        self.assertEqual(result["signals"]["relation_basis"], "conflict")
        self.assertIn(result["code"], {"candidate", "direct_conflict_candidate"})
        text = render_screen(result["signals"])
        self.assertNotIn("互补、适用边界或共同盲点", text)

    def test_opposed_stance_is_a_conflict_signal(self):
        """一方主张该做、另一方主张不该做：客观可核的分歧信号。"""
        a = node("我认为有家庭负担的人也该果断辞职创业，机会窗口不会等你",
                 "有家庭负担的人该不该裸辞", "should", audience=["上有老下有小"])
        b = node("如果你上有老下有小，我不建议你冲动辞职，先用副业验证想法",
                 "有家庭负担的人该不该裸辞", "should_not", audience=["上有老下有小"])
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        codes = {item["code"] for item in result["signals"]["conflict_signals"]}
        self.assertIn("stance_opposed", codes)

    def test_absolute_versus_conditional_is_a_conflict_signal(self):
        """一方给绝对判断、另一方认为要看条件：元层/条件分歧的客观形态。"""
        a = node("我认为任何人都不该在没有积蓄的时候辞职创业，这是铁律",
                 "该不该在没有积蓄时裸辞", "should_not", strength="absolute")
        b = node("这件事要看你所在行业的回款周期，有的人扛得住有的人扛不住",
                 "该不该在没有积蓄时裸辞", "conditional", strength="conditional")
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        codes = {item["code"] for item in result["signals"]["conflict_signals"]}
        self.assertIn("absolute_vs_conditional", codes)

    def test_axis_overlap_needs_enough_shared_grams(self):
        """C1：两侧 axis 措辞不同且完整观点也不共享概念时，仍要拒绝。

        v3 把 AXIS_OVERLAP_MIN 降到 1 后，未对齐的 axis 会继续走 semantic 回退层，
        由完整观点再判一次。这里两句话分属选专业与周末安排，两层都过不了，
        因此最终仍是 axis_mismatch——放宽阈值不等于放行无关配对。
        """
        a = node("我认为选专业该优先看转身空间", "选专业时该优先看什么", "should")
        b = node("我觉得周末该用来彻底休息", "周末该怎么安排休息", "should")
        result = screen_pair(a, b)
        self.assertFalse(result["collidable"])
        self.assertEqual(result["code"], "axis_mismatch")
        axis = result["signals"]["axis"]
        # axis 二元组没达到门槛，才会落到 semantic 层；semantic 也没达标，所以被拒。
        self.assertEqual(axis["level"], "semantic")
        self.assertLess(axis["shared_count"], axis["threshold"])
        self.assertLess(axis["statement_shared_count"], axis["statement_threshold"])

    def test_statement_semantics_can_recover_differently_worded_axes(self):
        a = node("职业规划应该避开重复劳动，给未来保留成长空间",
                 "是否应选择重复劳动的岗位", "should_not")
        b = node("做职业规划时要优先考虑能持续成长的工作",
                 "长期职业规划最该看什么", "should")
        result = screen_pair(a, b)
        self.assertTrue(result["collidable"])
        self.assertEqual(result["signals"]["axis"]["level"], "semantic")
        self.assertGreaterEqual(result["signals"]["axis"]["statement_shared_count"], 2)

    def test_fallback_alignment_needs_stronger_evidence_for_divergence(self):
        """axis 缺失时，「同轴异答」信号要求更高的共享词门槛。

        C1 入门门槛是 5；勉强达标的弱对齐不足以反推「分歧存在」，
        需达到 DIVERGENCE_FALLBACK_SHARED_MIN 才给信号。
        """
        strong_a = node("我认为方向没定的人该优先看专业的转身空间，而不是收入天花板",
                        "", "should")
        strong_b = node("我觉得选专业还是该看收入天花板，转身空间是想太多了",
                        "", "should")
        strong = screen_pair(strong_a, strong_b)
        self.assertTrue(strong["collidable"])
        self.assertEqual(strong["signals"]["axis"]["level"], "fallback")
        codes = {item["code"] for item in strong["signals"]["conflict_signals"]}
        self.assertIn("same_axis_divergent_claims", codes)


if __name__ == "__main__":
    unittest.main()
