# -*- coding: utf-8 -*-
"""把收集的 md 语料解析成标准样本 JSON。

关键设计：**清洗后的文本就是唯一的「原文」**。

这一点必须严格遵守。char_offset 是拿 quote 回原文做字符串反查得到的；
如果送模型的是去图文本、而定位用的是原始文本，两边偏移量会整体错位，
前端点 quote 跳转时会高亮到错误位置。这个 bug 跑通了也看不出来，
要等到演示现场点一下才暴露。所以清洗必须发生在抽取与定位之前，
且两者共用同一份清洗结果。

用法（在 extractor/ 下执行）：
    python parse_samples.py --dir "../private-data/collision/测试实例" \
                            --outdir "../private-data/collision/测试数据/标准样本"

输出：每个问题一个 JSON，格式与 run_extract.py 的 --input 一致：
[{"answer_id": "q5_a1", "question": "...", "author": "...", "content": "..."}]
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# ---- 结构标记 ----
RE_QTITLE = re.compile(r"^#\s*问题\s*[:：]\s*(.+?)\s*$", re.M)
RE_QDETAIL_HEAD = re.compile(r"^问题详情\s*[:：]?\s*$", re.M)
RE_ANSWER_HEAD = re.compile(r"^##\s*回答\s*(\d+)\s*[:：]?\s*$", re.M)
RE_AUTHOR = re.compile(r"^作者\s*[:：]\s*(.*)$", re.M)
RE_DETAIL_HEAD = re.compile(r"^回答详情\s*[:：]?\s*$", re.M)

# ---- 噪声 ----
RE_IMG = re.compile(r"<img[^>]*?>", re.S)
RE_HTML_TAG = re.compile(r"</?(?:br|p|div|span|b|i|u|em|strong|figure|noscript)[^>]*>", re.I)
RE_SEP = re.compile(r"^\s*-{3,}\s*$", re.M)
RE_BARE_URL_LINE = re.compile(r"^\s*https?://\S+\s*$", re.M)
RE_MULTI_BLANK = re.compile(r"\n{3,}")
RE_LONE_DOT = re.compile(r"^\s*[。.]\s*$", re.M)   # 语料里有整行只有句号的分隔行
RE_ZERO_WIDTH = re.compile(r"[\u200b\u200c\u200d\ufeff\u2060]")


def clean_author(raw: str) -> str:
    """作者名：去零宽字符与知乎的认证小尾巴。"""
    s = RE_ZERO_WIDTH.sub("", raw or "").strip()
    return s or "匿名用户"


def clean_content(raw: str) -> str:
    """正文清洗。顺序重要：先去标签，再规整空白。

    只做「删除」类操作，不做任何替换改写，
    以免 quote 定位时原文与模型看到的文本产生语义偏差。

    特别注意：**不要用 unicodedata.NFKC 归一化**。
    NFKC 会把全角中文标点「，：（）」转成半角「,:()」，
    导致 quote 逐字摘录出来的句子标点损坏，中文页面上一眼可见。
    标点差异由 quote_locator.py 在匹配时内部处理，不必污染原文。
    """
    t = RE_ZERO_WIDTH.sub("", raw)
    t = RE_IMG.sub("", t)              # 图片：无 caption，不携带文本信息
    t = RE_HTML_TAG.sub("", t)
    t = RE_BARE_URL_LINE.sub("", t)    # 独占一行的裸链接
    t = RE_LONE_DOT.sub("", t)
    t = "\n".join(line.rstrip() for line in t.splitlines())
    t = RE_MULTI_BLANK.sub("\n\n", t)
    return t.strip()


def parse_file(path: Path, qidx: str) -> dict:
    text = path.read_text(encoding="utf-8")

    m = RE_QTITLE.search(text)
    question = clean_author(m.group(1)) if m else path.stem
    question = re.sub(r"^问题\d+[-－]", "", question).strip()

    # 问题详情：从「问题详情」到第一个 ## 回答 之间
    q_detail = ""
    md = RE_QDETAIL_HEAD.search(text)
    first_ans = RE_ANSWER_HEAD.search(text)
    if md and first_ans:
        q_detail = clean_content(RE_SEP.sub("", text[md.end():first_ans.start()]))

    heads = list(RE_ANSWER_HEAD.finditer(text))
    items = []
    for i, h in enumerate(heads):
        seg_end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        seg = text[h.end():seg_end]

        ma = RE_AUTHOR.search(seg)
        author = clean_author(ma.group(1)) if ma else "匿名用户"

        md2 = RE_DETAIL_HEAD.search(seg)
        body = seg[md2.end():] if md2 else (seg[ma.end():] if ma else seg)
        body = RE_SEP.sub("", body)
        content = clean_content(body)

        if len(content) < 80:          # 过短的回答抽不出有意义的结构
            continue

        items.append({
            # 用顺序序号而非原文的「回答N」编号：语料里出现过同一文件内
            # 两个「## 回答3」，若沿用原文编号会导致 answer_id 重复，
            # 后写入的文件覆盖前者，表现为「样本 11 篇但只产出 10 篇」且不报错。
            "answer_id": f"{qidx}_a{len(items) + 1}",
            "src_label": f"回答{h.group(1)}",      # 保留原文编号便于回溯
            "question": question,
            "question_detail": q_detail,
            "author": author,
            "content": content,
            "_source_file": path.name,
            "_raw_chars": seg_end - h.end(),
            "_clean_chars": len(content),
        })
    return {"question": question, "items": items}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()

    src = Path(args.dir)
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    files = sorted(src.glob("*.md"))
    if not files:
        print(f"[X] 目录下没有 .md: {src}")
        return

    print("-" * 70)
    total = 0
    index = []
    for f in files:
        m = re.match(r"问题(\d+)", f.name)
        qidx = f"q{m.group(1)}" if m else f.stem[:4]
        res = parse_file(f, qidx)
        items = res["items"]
        if not items:
            print(f"[!] {f.name[:26]} 未解析出回答")
            continue

        dst = out / f"{qidx}_样本.json"
        dst.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

        raw = sum(i["_raw_chars"] for i in items)
        cln = sum(i["_clean_chars"] for i in items)
        avg = cln // len(items)
        print(f"[OK] {qidx}  {len(items):>2} 篇  原始 {raw:>6} → 清洗后 {cln:>6} "
              f"(-{100 - cln * 100 // max(raw,1):>2}%)  均长 {avg:>5}  {dst.name}")
        total += len(items)
        index.append({"qid": qidx, "question": res["question"],
                      "file": dst.name, "answers": len(items), "avg_chars": avg})

    (out / "_索引.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print("-" * 70)
    print(f"共 {total} 篇回答，输出至 {out}")


if __name__ == "__main__":
    main()
