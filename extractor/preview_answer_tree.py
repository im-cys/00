# -*- coding: utf-8 -*-
"""从样本文件抽取单篇观点树并打印 JSON，供本地提示词迭代。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from run_extract import extract_one, load_dotenv, strip_internal


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="预览单篇回答的观点树 V2")
    parser.add_argument("--input", required=True, help="回答数组 JSON")
    parser.add_argument("--answer-id", required=True, help="要抽取的回答编号")
    parser.add_argument("--mock", help="可选：使用指定的模型原始输出，不调用模型")
    parser.add_argument("--env", help="可选：从指定 .env 读取模型配置")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.env:
        load_dotenv(Path(args.env))

    items = json.loads(Path(args.input).read_text(encoding="utf-8"))
    item = next((value for value in items if str(value.get("answer_id")) == args.answer_id), None)
    if not item:
        raise SystemExit(f"没有找到回答：{args.answer_id}")
    mock_raw = json.loads(Path(args.mock).read_text(encoding="utf-8")) if args.mock else None
    payload, report = extract_one(item, mock_raw=mock_raw, verbose=args.verbose)
    print(json.dumps({"map": strip_internal(payload), "report": report}, ensure_ascii=False, indent=2))
    if not report.get("ok"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
