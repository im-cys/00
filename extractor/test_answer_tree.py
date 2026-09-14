# -*- coding: utf-8 -*-
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_extract import strip_internal  # noqa: E402
from collide_service import _tree_to_frontend  # noqa: E402
from schema_validator import MAX_EXPLANATION_LEN, normalize  # noqa: E402


def collision(statement, quote, **kwargs):
    """构造一个通过基础校验的 collision，便于各用例只关注自己那一项差异。"""
    node = {
        "kind": "collision",
        "display_text": kwargs.pop("display_text", "方向未定时优先看转身空间"),
        "statement": statement,
        "role": kwargs.pop("role", "criterion"),
        "axis": kwargs.pop("axis", "选专业时该优先看什么"),
        "stance": kwargs.pop("stance", "should"),
        "conditions": kwargs.pop("conditions", {"audience": ["方向尚未明确"], "stage": [], "premise": []}),
        "supports": [{"type": "quote", "summary": "原文支撑", "quote": quote}],
    }
    node.update(kwargs)
    return node


class AnswerTreeTest(unittest.TestCase):
    def setUp(self):
        self.source = (
            "理由不是因为钱多，其实有很多专业比口腔钱多。"
            "口腔的人生方向选择比较多，可以根据未来爱好选择不同方向。\n"
            "如果想找一份稳定的工作，口腔多数科室没有夜班。\n"
            "我是极度不建议你冲动辞职，从零开始。\n"
            "其他院校的招生和就业情况对我来说超纲，无法给出靠谱建议。"
        )

    def test_variable_tree_depth_and_grounded_collision_frontier(self):
        raw = {
            "root": {
                "kind": "root",
                "statement": "对方向尚未明确的学生，口腔医学的价值在于保留更多职业选择",
                # branch 必须真的组织 2 个以上并列子节点，否则会被折叠。
                # 这里用「有兄弟节点」的方式制造深度差，而不是靠单子嵌套。
                "children": [
                    collision(
                        "我认为方向还没定下来的时候，专业留给你的选择空间比它当下的收入天花板更值得看",
                        "理由不是因为钱多，其实有很多专业比口腔钱多。",
                    ),
                    {
                        "kind": "branch",
                        "title": "职业路径",
                        "display_text": "口腔医学能提供多条职业路径",
                        "summary": "口腔提供的具体发展路径",
                        "children": [
                            {
                                "kind": "branch",
                                "title": "医院就业",
                                "display_text": "医院口腔岗位更适合稳定就业",
                                "summary": "医院岗位的工作方式",
                                "children": [
                                    collision(
                                        "如果你要的是稳定，我会把医院口腔岗位算作一条可行路径，因为多数科室不用值夜班",
                                        "如果想找一份稳定的工作，口腔多数科室没有夜班。",
                                        role="recommendation",
                                        display_text="医院岗位适合想要稳定的人",
                                        axis="要不要把医院口腔岗位当稳定选择",
                                        stance="should",
                                        conditions={"audience": [], "stage": [], "premise": ["想找一份稳定的工作"]},
                                    ),
                                    collision(
                                        "如果你已经有家庭要养，我不建议你直接裸辞去做这件事，风险不该由家人承担",
                                        "我是极度不建议你冲动辞职，从零开始。",
                                        role="qualification",
                                        display_text="有家庭负担时不该直接裸辞",
                                        axis="有家庭负担的人该不该裸辞",
                                        stance="should_not",
                                        conditions={"audience": ["有家庭要养"], "stage": [], "premise": []},
                                    ),
                                ],
                            },
                            collision(
                                "如果你还想保留转方向的余地，我会说口腔的细分方向足够多，可以按以后的爱好再挑",
                                "口腔的人生方向选择比较多，可以根据未来爱好选择不同方向。",
                                role="reason",
                                display_text="口腔细分方向多留有转身余地",
                                axis="口腔能不能保留转方向的余地",
                                stance="should",
                                conditions={"audience": [], "stage": [], "premise": ["还想保留转方向的余地"]},
                            ),
                        ],
                    }
                ]
            },
            "boundaries": [{
                "summary": "无法覆盖其他院校招生和就业情况",
                "quote": "其他院校的招生和就业情况对我来说超纲，无法给出靠谱建议。"
            }]
        }
        payload, report = normalize(raw, self.source, "q6_a9", "大学什么专业最好？")
        self.assertTrue(report.ok)
        self.assertEqual(payload["schema_version"], "answer-tree-v2")
        self.assertEqual(len(payload["nodes"]), 4)
        # 深度不同（1 与 3），密度带允许：可碰撞层级由密度决定，不要求同层。
        self.assertEqual(report.stats["collision_depth_min"], 1)
        self.assertEqual(report.stats["collision_depth_max"], 3)
        # nodes 表里全部是 collision，collidable 已是恒定值，精简后不再重复存储。
        self.assertTrue(all("collidable" not in node for node in payload["nodes"]))
        self.assertEqual(payload["nodes"][1]["collision_role"], "recommendation")
        self.assertEqual(len(payload["boundaries"]), 1)
        public = strip_internal({**payload, "_raw_model_output": raw})
        self.assertNotIn("_raw_model_output", public)
        frontend_tree = _tree_to_frontend(public["tree"])
        self.assertEqual(frontend_tree["kind"], "root")
        self.assertFalse(frontend_tree["collidable"])
        self.assertTrue(frontend_tree["children"][0]["collidable"])
        self.assertEqual(frontend_tree["children"][0]["displayText"], "方向未定时优先看转身空间")
        self.assertEqual(frontend_tree["children"][1]["displayText"], "口腔医学能提供多条职业路径")
        self.assertEqual(frontend_tree["children"][1]["children"][0]["children"][0]["kind"], "collision")

    def test_display_text_is_concise_while_statement_keeps_full_semantics(self):
        """卡片短观点与碰撞使用的完整观点分层保存，并映射到前端。"""
        full = "如果你的方向还没定下来，我会让你先看这个专业留给你的转身空间，而不是它当下的收入天花板"
        raw = {
            "root": {
                "kind": "root",
                "display_text": "口腔医学保留更多职业选择",
                "statement": "对方向尚未明确的学生，口腔医学的价值在于保留更多职业选择",
                "children": [collision(
                    full,
                    "理由不是因为钱多，其实有很多专业比口腔钱多。",
                    display_text="方向未定时优先看转身空间",
                )],
            },
            "boundaries": [],
        }
        payload, report = normalize(raw, self.source, "q6_display", "大学什么专业最好？")
        self.assertTrue(report.ok)
        self.assertEqual(payload["tree"]["display_text"], "口腔医学保留更多职业选择")
        self.assertEqual(payload["nodes"][0]["display_text"], "方向未定时优先看转身空间")
        self.assertEqual(payload["nodes"][0]["statement"], full)
        frontend = _tree_to_frontend(payload["tree"])
        self.assertEqual(frontend["displayText"], "口腔医学保留更多职业选择")
        self.assertEqual(frontend["children"][0]["displayText"], "方向未定时优先看转身空间")

    # ------------------------------------------------------------------
    # v2.8：观点解释（explanation）
    # ------------------------------------------------------------------

    def _one_collision(self, answer_id, **kwargs):
        raw = {
            "root": {
                "kind": "root",
                "display_text": "口腔医学保留更多职业选择",
                "statement": "对方向尚未明确的学生，口腔医学的价值在于保留更多职业选择",
                "children": [collision(
                    "我认为方向还没定下来的时候，专业留给你的选择空间比它当下的收入天花板更值得看",
                    "理由不是因为钱多，其实有很多专业比口腔钱多。",
                    **kwargs,
                )],
            },
            "boundaries": [],
        }
        return normalize(raw, self.source, answer_id, "大学什么专业最好？")

    def test_explanation_is_kept_and_mapped_to_frontend(self):
        """合格的观点解释逐字保留，并映射到前端节点与树。"""
        text = (
            "这话是对还没锁定方向的人说的。收入天花板是当下能查到的数字，"
            "转身空间要几年后才兑现，所以前者容易被高估。"
            "但如果你已经确定要一条道走到底，这个标准就不适用了。"
        )
        payload, report = self._one_collision("q6_exp", explanation=text)
        self.assertTrue(report.ok)
        self.assertEqual(payload["nodes"][0]["explanation"], text)
        self.assertEqual(payload["tree"]["children"][0]["explanation"], text)
        frontend = _tree_to_frontend(payload["tree"])
        self.assertEqual(frontend["children"][0]["explanation"], text)

    def test_explanation_echoing_statement_is_dropped(self):
        """只是把 statement 换个说法重讲一遍，不算解释。"""
        payload, report = self._one_collision(
            "q6_echo",
            explanation=("作者认为方向还没定下来的时候，专业留给你的选择空间"
                         "比它当下的收入天花板更值得看，所以选择空间比收入天花板重要。"),
        )
        self.assertTrue(report.ok)          # 只影响展示，不拖垮整棵树
        self.assertEqual(payload["nodes"][0]["explanation"], "")
        self.assertTrue(any("只是复读 statement" in item["reason"] for item in report.fixed))

    def test_too_short_explanation_is_dropped(self):
        payload, report = self._one_collision("q6_short", explanation="收入天花板容易被高估。")
        self.assertTrue(report.ok)
        self.assertEqual(payload["nodes"][0]["explanation"], "")
        self.assertTrue(any("explanation 过短" in item["reason"] for item in report.fixed))

    def test_missing_explanation_does_not_fail_the_tree(self):
        """缺字段时降级为空串，由前端显示完整观点，不触发整树重试。"""
        payload, report = self._one_collision("q6_none")
        self.assertTrue(report.ok)
        self.assertEqual(payload["nodes"][0]["explanation"], "")
        self.assertTrue(any("缺少 explanation" in item["reason"] for item in report.fixed))

    def test_explanation_is_length_capped(self):
        payload, report = self._one_collision(
            "q6_long",
            explanation="这个判断的前提是你还没有锁定方向，因此需要保留调整余地。" * 20,
        )
        self.assertTrue(report.ok)
        self.assertLessEqual(len(payload["nodes"][0]["explanation"]), MAX_EXPLANATION_LEN)

    def test_incomplete_display_text_is_repaired_without_discarding_tree(self):
        """短标题是展示字段，残留连接词时应修复，不能浪费整次模型生成。"""
        raw = {
            "root": {
                "kind": "root",
                "display_text": "城市条件比专业选择更能决定结果，因此",
                "statement": "在选大学时，我认为城市条件比专业选择更能决定最终结果",
                "children": [collision(
                    "我认为方向还没定下来的时候，专业留给你的选择空间比它当下的收入天花板更值得看",
                    "理由不是因为钱多，其实有很多专业比口腔钱多。",
                )],
            },
            "boundaries": [],
        }
        payload, report = normalize(raw, self.source, "q6_bad_display", "大学什么专业最好？")
        self.assertTrue(report.ok)
        self.assertEqual(payload["tree"]["display_text"], "城市条件比专业选择更能决定结果")
        self.assertTrue(any("display_text 不合格" in item["reason"] for item in report.fixed))

    def test_structured_semantics_are_normalized(self):
        """axis / stance / conditions / excludes 落地，excludes 需原文排除表述。"""
        raw = {
            "root": {
                "kind": "root",
                "statement": "对有家庭负担的人，我不建议裸辞创业",
                "children": [collision(
                    "如果你上有老下有小，我不建议你冲动辞职，先把想做的事放在副业里试",
                    "我是极度不建议你冲动辞职，从零开始。",
                    role="recommendation",
                    axis="有家庭负担的人该不该裸辞",
                    stance="should_not",
                    conditions={"audience": ["上有老下有小"], "stage": ["工作几年后"], "premise": []},
                    excludes=["冲动辞职从零开始"],
                    strength="conditional",
                    tradeoff="副业推进速度更慢",
                )]
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q1_a2", "该不该辞职创业？")
        self.assertTrue(report.ok)
        node = payload["nodes"][0]
        self.assertEqual(node["axis"], "有家庭负担的人该不该裸辞")
        self.assertEqual(node["stance"], "should_not")
        self.assertEqual(node["conditions"]["audience"], ["上有老下有小"])
        self.assertEqual(node["conditions"]["stage"], ["工作几年后"])
        self.assertEqual(node["excludes"], ["冲动辞职从零开始"])
        self.assertEqual(node["strength"], "conditional")
        self.assertEqual(node["tradeoff"], "副业推进速度更慢")
        semantics = report.stats["semantics"]
        self.assertEqual(semantics["axis_filled"], 1)
        self.assertEqual(semantics["with_excludes"], 1)
        self.assertEqual(semantics["stance_mix"], {"should_not": 1})
        # 精简后的节点不再携带恒定值与重复字段。
        for removed in ("claim_text", "type", "polarity", "scopes", "grounded", "derived_from", "_counter", "role"):
            self.assertNotIn(removed, node)

    def test_fabricated_excludes_dropped_and_stance_inferred(self):
        """原文没有排除表述时 excludes 被丢弃；stance 漏填时按表述特征推断。"""
        raw = {
            "root": {
                "kind": "root",
                "statement": "口腔医学值得考虑",
                "children": [collision(
                    "在我看来只要你还没想清楚方向，这个专业留下的选择空间就值得你认真算一算",
                    "口腔的人生方向选择比较多，可以根据未来爱好选择不同方向。",
                    stance=None,
                    excludes=["只看收入排名"],
                )]
            },
            "boundaries": []
        }
        # 这份 source 不含任何排除表述，excludes 应被判为虚构而丢弃。
        clean_source = "口腔的人生方向选择比较多，可以根据未来爱好选择不同方向。"
        payload, report = normalize(raw, clean_source, "q6_clean", "大学什么专业最好？")
        self.assertTrue(report.ok)
        node = payload["nodes"][0]
        self.assertEqual(node["excludes"], [])
        self.assertTrue(any("excludes 在原文中找不到排除表述" in item["reason"] for item in report.fixed))
        self.assertIn(node["stance"], {"conditional", "should"})
        self.assertTrue(any("stance 缺失或非法" in item["reason"] for item in report.fixed))

    def test_density_band_is_measured_across_branches(self):
        """深度不同但密度对齐；密度画像逐节点可查。"""
        raw = {
            "root": {
                "kind": "root",
                "statement": "对方向尚未明确的学生，我更看重口腔能保留下来的选择空间",
                "children": [
                    collision(
                        "如果你的方向还没定下来，我会让你先看这个专业留给你的转身空间，而不是它当下的收入天花板",
                        "理由不是因为钱多，其实有很多专业比口腔钱多。",
                    ),
                    {
                        "kind": "branch",
                        "title": "职业路径",
                        "summary": "口腔提供的具体发展路径",
                        # 两个并列子节点，branch 才有组织意义，不会被折叠。
                        "children": [
                            collision(
                                "如果你要的是稳定，我会把医院口腔岗位算作一条可行路径，因为多数科室不用值夜班",
                                "如果想找一份稳定的工作，口腔多数科室没有夜班。",
                                role="recommendation",
                                display_text="医院岗位适合想要稳定的人",
                            ),
                            collision(
                                "如果你还想保留转方向的余地，我会说口腔的细分方向足够多，可以按以后的爱好再挑",
                                "口腔的人生方向选择比较多，可以根据未来爱好选择不同方向。",
                                role="reason",
                                display_text="口腔细分方向多留有转身余地",
                            ),
                        ]
                    }
                ]
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q6_density", "大学什么专业最好？")
        self.assertTrue(report.ok)
        density = report.stats["density"]
        self.assertEqual(report.stats["collision_depth_min"], 1)
        self.assertEqual(report.stats["collision_depth_max"], 2)
        self.assertTrue(density["aligned"])
        self.assertFalse(density["severe"])
        self.assertLessEqual(density["len_spread"], density["spread_limit"])
        self.assertLessEqual(density["len_ratio"], density["ratio_limit"])
        self.assertEqual(density["multi_sentence_ids"], [])
        self.assertEqual(density["first_person_rate"], 1.0)
        for node in payload["nodes"]:
            self.assertEqual(node["density"]["shape"], "single_sentence")

    def test_over_dense_statement_is_rejected_and_shape_is_cleaned(self):
        """密度过高的节点直接判失配；标题前缀与转述框架被清洗掉。"""
        raw = {
            "root": {
                "kind": "root",
                "statement": "作者认为：口腔医学能保留更多选择",
                "children": [
                    collision(
                        "核心观点：选专业要看兴趣，也要看收入，而且口腔的就业面比临床宽，"
                        "医院岗位比较稳定，作息能预期，创业开诊所也有机会，读研方向多，"
                        "考公考编也留了口子，家里有诊所的还能直接接班，"
                        "所以综合来看口腔是性价比最高的选择，方向没定的人尤其应该考虑",
                        "理由不是因为钱多，其实有很多专业比口腔钱多。",
                        role="conclusion",
                    ),
                    collision(
                        "作者认为，如果你要的是稳定，医院口腔岗位是一条可行路径，因为多数科室不用值夜班",
                        "如果想找一份稳定的工作，口腔多数科室没有夜班。",
                        role="recommendation",
                    ),
                ]
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q6_dense", "大学什么专业最好？")
        self.assertTrue(report.ok)
        self.assertEqual(len(payload["nodes"]), 1)
        self.assertTrue(any("密度过高" in item["reason"] for item in report.dropped))
        self.assertTrue(payload["nodes"][0]["statement"].startswith("如果你要的是稳定"))
        self.assertEqual(payload["tree"]["statement"], "口腔医学能保留更多选择")

    def test_single_child_branch_is_collapsed_so_collision_stops_at_its_own_depth(self):
        """已达到密度带的观点不该被多套一层 branch。

        实测问题：模型给第一个观点单独包了一层 branch，用户看到那层就以为
        这个观点还需要继续往下拆。branch 只有一个子节点时它没有在组织任何
        东西，应当把 collision 直接上提。
        """
        raw = {
            "root": {
                "kind": "root",
                "statement": "对方向尚未明确的学生，口腔医学的价值在于保留更多职业选择",
                "display_text": "口腔医学保留更多职业选择",
                "children": [{
                    "kind": "branch",
                    "title": "判断标准",
                    "display_text": "选专业该看留下的选择空间",
                    "summary": "作者用什么标准判断专业好坏",
                    "children": [collision(
                        "我认为方向还没定下来的时候，专业留给你的选择空间比它当下的收入天花板更值得看",
                        "理由不是因为钱多，其实有很多专业比口腔钱多。",
                    )],
                }],
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q6_flat", "大学什么专业最好？")
        self.assertTrue(report.ok)
        # collision 上提到 root 直属，深度为 1，不再隔着一层 branch。
        self.assertEqual(report.stats["collision_depth_min"], 1)
        self.assertEqual(report.stats["collision_depth_max"], 1)
        self.assertEqual(report.stats["branch_count"], 0)
        self.assertEqual(payload["tree"]["children"][0]["kind"], "collision")
        # ancestor_path 也按折叠后的结构算，不留下已消失的 branch。
        self.assertEqual([entry["id"] for entry in payload["nodes"][0]["ancestor_path"]],
                         ["q6_flat_root"])
        self.assertTrue(any("已折叠" in item["reason"] for item in report.fixed))

    def test_single_child_branch_chain_collapses_all_the_way_down(self):
        """branch → branch → collision 的单子链一路折平到 root 直属。"""
        raw = {
            "root": {
                "kind": "root",
                "statement": "对方向尚未明确的学生，口腔医学的价值在于保留更多职业选择",
                "display_text": "口腔医学保留更多职业选择",
                "children": [{
                    "kind": "branch",
                    "title": "职业路径",
                    "display_text": "口腔医学能提供多条职业路径",
                    "summary": "口腔提供的具体发展路径",
                    "children": [{
                        "kind": "branch",
                        "title": "医院就业",
                        "display_text": "医院口腔岗位更适合稳定就业",
                        "summary": "医院岗位的工作方式",
                        "children": [collision(
                            "如果你要的是稳定，我会把医院口腔岗位算作一条可行路径，因为多数科室不用值夜班",
                            "如果想找一份稳定的工作，口腔多数科室没有夜班。",
                            role="recommendation",
                        )],
                    }],
                }],
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q6_chain", "大学什么专业最好？")
        self.assertTrue(report.ok)
        self.assertEqual(report.stats["branch_count"], 0)
        self.assertEqual(report.stats["collision_depth_max"], 1)
        self.assertEqual(payload["tree"]["children"][0]["kind"], "collision")

    def test_branch_with_multiple_children_is_preserved(self):
        """真正在组织并列子节点的 branch 必须保留，折叠不能一刀切。"""
        raw = {
            "root": {
                "kind": "root",
                "statement": "对方向尚未明确的学生，口腔医学的价值在于保留更多职业选择",
                "display_text": "口腔医学保留更多职业选择",
                "children": [{
                    "kind": "branch",
                    "title": "职业路径",
                    "display_text": "口腔医学能提供多条职业路径",
                    "summary": "口腔提供的具体发展路径",
                    "children": [
                        collision(
                            "如果你要的是稳定，我会把医院口腔岗位算作一条可行路径，因为多数科室不用值夜班",
                            "如果想找一份稳定的工作，口腔多数科室没有夜班。",
                            role="recommendation",
                            display_text="医院岗位适合想要稳定的人",
                        ),
                        collision(
                            "如果你还想保留转方向的余地，我会说口腔的细分方向足够多，可以按以后的爱好再挑",
                            "口腔的人生方向选择比较多，可以根据未来爱好选择不同方向。",
                            role="reason",
                            display_text="口腔细分方向多留有转身余地",
                        ),
                    ],
                }],
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q6_keep", "大学什么专业最好？")
        self.assertTrue(report.ok)
        self.assertEqual(report.stats["branch_count"], 1)
        self.assertEqual(payload["tree"]["children"][0]["kind"], "branch")
        self.assertEqual(len(payload["tree"]["children"][0]["children"]), 2)
        self.assertEqual(report.stats["collision_depth_max"], 2)
        self.assertFalse(any("已折叠" in item["reason"] for item in report.fixed))

    def test_ungrounded_leaf_is_removed_with_empty_branch(self):
        raw = {
            "root": {
                "kind": "root",
                "statement": "口腔医学提供多种职业选择",
                "children": [{
                    "kind": "branch",
                    "title": "不存在的分支",
                    "summary": "没有原文依据",
                    "children": [collision(
                        "一条没有任何原文依据的观点，条件和理由都写得很完整但引用是编的",
                        "原文里不存在这句话",
                    )]
                }]
            },
            "boundaries": []
        }
        payload, report = normalize(raw, self.source, "q6_bad", "大学什么专业最好？")
        self.assertFalse(report.ok)
        self.assertEqual(payload, {})
        self.assertIn("collision", report.fatal)


if __name__ == "__main__":
    unittest.main()
