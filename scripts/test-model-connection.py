# -*- coding: utf-8 -*-
"""Test the configured OpenAI-compatible model without sending private answer data."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "extractor"))

from run_extract import call_llm, get_config, load_dotenv  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=Path, default=PROJECT_ROOT / "private-data" / ".env")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    load_dotenv(args.env)
    config = get_config()
    started = time.monotonic()
    try:
        raw = call_llm([
            {"role": "system", "content": "Return one valid JSON object and nothing else."},
            {"role": "user", "content": 'Return exactly {"ok":true}.'},
        ], temperature=0, timeout=args.timeout)
        parsed = json.loads(raw)
        if parsed.get("ok") is not True:
            raise RuntimeError("The model returned JSON but not the requested test value.")
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "model": config["model"],
            "base_host": config["base"].split("//")[-1].split("/")[0],
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "error": str(error)[:500],
        }, ensure_ascii=False))
        return 1

    print(json.dumps({
        "ok": True,
        "model": config["model"],
        "base_host": config["base"].split("//")[-1].split("/")[0],
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
