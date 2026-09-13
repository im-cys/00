# -*- coding: utf-8 -*-
"""补跑：只抽取目标目录中尚未成功的回答。

免费档在拥塞时段会有个别篇目耗尽重试而失败。本脚本对照样本与已产出的
nodes/*.json，只补跑缺失的部分，避免重复消耗配额。

用法（在 extractor/ 下执行）：
    python fill_missing.py --input "<样本.json>" --outdir "<实测报告目录>"
    python fill_missing.py --input ... --outdir ... --check   # 只看缺哪些，不调模型
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from run_extract import extract_one, strip_internal


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--check", action="store_true", help="只检查缺失，不调用模型")
    ap.add_argument("--sleep", type=float, default=3.0)
    args = ap.parse_args()

    out = Path(args.outdir)
    (out / "nodes").mkdir(parents=True, exist_ok=True)
    items = json.loads(Path(args.input).read_text(encoding="utf-8"))

    done = {p.stem for p in (out / "nodes").glob("*.json") if not p.stem.endswith(".debug")}
    ids = [i["answer_id"] for i in items]
    dup = {x for x in ids if ids.count(x) > 1}
    if dup:
        # 样本里出现重复 answer_id 时，后写入的文件会覆盖前者，
        # 用集合比对会显示「缺失 0」从而掩盖问题，必须显式报错。
        print(f"[!] 样本存在重复 answer_id：{sorted(dup)}")
        print("    请重新运行 parse_samples.py 生成样本，否则会静默丢失回答。")
    missing = [i for i in items if i["answer_id"] not in done]

    print(f"样本 {len(items)} 篇，已完成 {len(done)} 篇，缺失 {len(missing)} 篇")
    if missing:
        print("缺失：", [i["answer_id"] for i in missing])
    if args.check or not missing:
        return

    rp = out / "report.json"
    reports = json.loads(rp.read_text(encoding="utf-8")) if rp.exists() else []
    reports = [r for r in reports if r.get("ok")]

    for idx, it in enumerate(missing, 1):
        aid = it["answer_id"]
        print(f"[{idx}/{len(missing)}] {aid} ...", end="", flush=True)
        if idx > 1:
            time.sleep(args.sleep)
        payload, rep = extract_one(it, verbose=True)
        if not rep["ok"]:
            print(f"\r[FAIL] {aid}: {rep['fatal']}")
            continue
        (out / "nodes" / f"{aid}.json").write_text(
            json.dumps(strip_internal(payload), ensure_ascii=False, indent=2), encoding="utf-8")
        (out / "nodes" / f"{aid}.debug.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        reports.append(rep)
        s = rep["stats"]
        print(f"\r[OK] {aid}  nodes={s.get('node_count')} stance={s.get('thesis_stance')}")

    rp.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"报告已更新：{rp}")


if __name__ == "__main__":
    main()
