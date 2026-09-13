# -*- coding: utf-8 -*-
"""测试实例体检：在跑抽取前，先摸清样本的形态与风险。

用法（在 extractor/ 下执行）：
    python inspect_samples.py --dir "../private-data/collision/测试实例"

回答两个问题：
1. 图片承载了多少信息量？（决定是否需要多模态）
2. 样本规模是否适合直接喂给模型？（决定是否需要截断/分段）
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

IMG = re.compile(r"<img[^>]*?>", re.S)
CAPTION = re.compile(r'data-caption="([^"]*)"')
ANSWER_HEAD = re.compile(r"^##\s*回答\s*(\d+)", re.M)

# 正文里指向图片的引用语，说明作者用文字复述了图意
REF_IMG = re.compile(
    r"(如图|上图|下图|图中|见图|这张图|这幅图|如下图|上面这张|截图|图上)"
)

BAR = "-" * 68


def analyze(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    imgs = IMG.findall(text)
    caps = [c for t in imgs for c in CAPTION.findall(t) if c.strip()]
    clean = IMG.sub("", text)
    return {
        "name": path.name,
        "chars": len(text),
        "chars_clean": len(clean),
        "answers": len(ANSWER_HEAD.findall(text)),
        "imgs": len(imgs),
        "caps": len(caps),
        "img_refs": len(REF_IMG.findall(clean)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()

    files = sorted(Path(args.dir).glob("*.md"))
    if not files:
        print(f"[X] 目录下没有 .md 文件: {args.dir}")
        return

    rows = [analyze(f) for f in files]

    print(BAR)
    print("样本体检")
    print(BAR)
    print(f"{'文件':<26}{'字符':>8}{'去图后':>8}{'回答':>5}{'图':>5}{'caption':>8}{'图引用':>7}")
    for r in rows:
        short = r["name"][:24]
        print(f"{short:<26}{r['chars']:>8}{r['chars_clean']:>8}"
              f"{r['answers']:>5}{r['imgs']:>5}{r['caps']:>8}{r['img_refs']:>7}")

    t_img = sum(r["imgs"] for r in rows)
    t_cap = sum(r["caps"] for r in rows)
    t_ref = sum(r["img_refs"] for r in rows)
    t_ans = sum(r["answers"] for r in rows)

    print(BAR)
    print(f"合计：{len(files)} 个问题 / {t_ans} 篇回答 / {t_img} 张图")
    print()
    print("【图片信息量判定】")
    print(f"  带 caption 文字的图：{t_cap}/{t_img}")
    print(f"  正文出现图片引用语：{t_ref} 处")
    if t_img:
        print(f"  图文比：平均每篇回答 {t_img / max(t_ans,1):.1f} 张图")
    if t_cap == 0:
        print("  → 图片自身不携带任何文本信息（无 caption）。")
    if t_ref < t_img * 0.5:
        print("  → 多数图片在正文中没有被显式引用，属于配图/佐证性质，")
        print("    作者的论点已由文字表达，图片主要起烘托与举证作用。")
    print()
    print("【单篇体量】")
    big = [r for r in rows if r["chars_clean"] / max(r["answers"], 1) > 4000]
    print(f"  平均每篇回答 {sum(r['chars_clean'] for r in rows) / max(t_ans,1):.0f} 字")
    if big:
        print(f"  [!] 以下文件单篇偏长，注意上下文窗口：{[b['name'][:18] for b in big]}")
    print(BAR)


if __name__ == "__main__":
    main()
