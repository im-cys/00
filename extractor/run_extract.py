# -*- coding: utf-8 -*-
"""抽取主流程：原文 -> 结构化 JSON。

代码目录与数据目录是分离的：本文件不假设测试数据的位置，
所有输入输出路径都通过命令行参数传入。

用法（在本文件所在目录执行）：
    # 1) 配置模型（OpenAI 兼容接口即可，也可换成任意自有网关）
    set EXTRACT_API_KEY=sk-xxx
    set EXTRACT_BASE_URL=https://api.openai.com/v1
    set EXTRACT_MODEL=gpt-4o-mini

    # 2) 真实抽取
    python run_extract.py --input <样本.json> --outdir <输出目录>

    # 3) 离线自测（不调模型，用预置的假模型输出跑通全链路与兜底）
    python run_extract.py --input <样本.json> --outdir <输出目录> --mock <mock模型输出.json>

输入样本 json 格式：
[
  {"answer_id": "a1", "question": "...", "author": "...", "content": "..."},
  ...
]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

from prompt_extract import (
    build_messages,
    RETRY_HINT_BAD_JSON,
    RETRY_HINT_DENSITY,
    RETRY_HINT_INVALID_TREE,
)
from schema_validator import normalize

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.S)

# GLM-4.7-Flash 等「混合思考模型」会在正文前输出推理段，必须先剥离，
# 否则 find("{") 会截到推理段里提到的花括号，导致 JSON 解析失败。
_THINK = re.compile(r"<think>.*?</think>|<thinking>.*?</thinking>", re.S | re.I)


def _strip_fence(text: str) -> str:
    t = _THINK.sub("", text.strip())
    t = _FENCE.sub("", t.strip())
    s, e = t.find("{"), t.rfind("}")
    return t[s:e + 1] if s >= 0 and e > s else t


def parse_json(text: str):
    """从模型输出中提取 JSON 对象。

    对混合思考模型做了加固：推理段可能未闭合，且其中常含干扰性花括号
    （例如「我需要输出 {groups:...} 这样的结构」）。因此在常规解析失败后，
    退化为从每一个 '{' 起点尝试 raw_decode，取第一个能完整解析出的对象。
    """
    if not text:
        return None
    # 快路径
    try:
        obj = json.loads(_strip_fence(text))
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    # 慢路径：逐个候选起点扫描，容忍未闭合推理段与前后杂音
    cleaned = _FENCE.sub("", _THINK.sub("", text).strip())
    decoder = json.JSONDecoder()
    best = None
    for i, ch in enumerate(cleaned):
        if ch != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(cleaned[i:])
        except ValueError:
            continue
        if isinstance(obj, dict):
            # 优先返回像抽取结果的对象，避免命中推理段里的小片段
            if "root" in obj or "nodes" in obj or "groups" in obj:
                return obj
            best = best or obj
    return best


# --------------------------------------------------------------------------
# 配置加载：.env 文件 > 系统环境变量
# --------------------------------------------------------------------------
def load_dotenv(path: Path | None = None) -> dict:
    """零依赖读取 .env。已存在的系统环境变量优先，不覆盖。

    .env 只放在本地，已被 .gitignore 忽略，不会进版本库、不会被分享。
    """
    path = path or (Path(__file__).resolve().parent.parent / ".env")
    loaded = {}
    if not path.exists():
        return loaded
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:      # 系统环境变量优先
            os.environ[k] = v
            loaded[k] = v
    return loaded


def get_config() -> dict:
    load_dotenv()
    try:
        sleep = float(os.environ.get("EXTRACT_SLEEP", "1.5"))
    except ValueError:
        sleep = 1.5
    return {
        "base": os.environ.get("EXTRACT_BASE_URL",
                               "https://open.bigmodel.cn/api/paas/v4").rstrip("/"),
        "key": os.environ.get("EXTRACT_API_KEY", ""),
        "model": os.environ.get("EXTRACT_MODEL", "glm-4.7-flash"),
        "sleep": sleep,
    }


def mask(secret: str) -> str:
    """脱敏显示，日志和报错里只出现这个形式。"""
    if not secret:
        return "(空)"
    return f"{secret[:6]}...{secret[-4:]}" if len(secret) > 14 else f"{secret[:3]}***"


# --------------------------------------------------------------------------
# LLM 调用层：只依赖 requests，换模型只改这里
# --------------------------------------------------------------------------
class RateLimited(Exception):
    """429 限流，调用方应退避后重试。"""


def call_llm(messages, temperature: float = 0.2, timeout: int = 180) -> str:
    import requests

    cfg = get_config()
    base, key, model = cfg["base"], cfg["key"], cfg["model"]
    if not key:
        raise RuntimeError(
            "缺少 EXTRACT_API_KEY。请在 代码/.env 中填写，"
            "或设置同名系统环境变量。可复制 .env.example 改名为 .env。"
        )

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    # GLM 混合思考模型：不关思考链会直接 429（实测），且延迟高。
    # 关闭后单次简单请求约 0.6s。非 GLM 模型不认识该字段，故按模型名判断。
    if "glm" in model.lower():
        payload["thinking"] = {"type": "disabled"}

    resp = requests.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=timeout,
    )
    if resp.status_code == 429:
        raise RateLimited(resp.text[:200])
    if resp.status_code >= 400:
        # 带上响应体，否则 raise_for_status 只给状态码，排错很痛苦
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        raise RuntimeError(f"响应结构异常: {json.dumps(data, ensure_ascii=False)[:300]}")


def call_llm_resilient(messages, max_attempts: int = 12, verbose: bool = False) -> str:
    """针对免费档共享池的重试包装。

    实测结论（glm-4.7-flash 免费档）：
      间隔 3s -> 成功 2/4   间隔 5s -> 1/4   间隔 8s -> 0/4
    429 的出现与请求间隔**无关**，错误码 1305 是「该模型当前访问量过大」，
    属于服务端共享池拥塞，不是本 Key 的频率配额。
    因此正确策略是「小间隔多次重试」，而不是拉长间隔。
    """
    last = None
    for i in range(max_attempts):
        try:
            return call_llm(messages)
        except RateLimited as e:
            last = e
            wait = min(2.0 + i * 0.8, 8.0)     # 温和递增，不做指数退避
            if verbose:
                print(f"\n      [429] 第 {i+1}/{max_attempts} 次，{wait:.1f}s 后重试", flush=True)
            time.sleep(wait)
        except Exception as e:
            last = e
            wait = min(3.0 + i * 1.5, 12.0)
            if verbose:
                print(f"\n      [ERR] {type(e).__name__}，{wait:.1f}s 后重试", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"重试 {max_attempts} 次仍失败: {last}")


def extract_one(item: dict, mock_raw: dict | None = None, retries: int = 2,
                verbose: bool = False, known_axes=None) -> tuple[dict, dict]:
    """抽取单篇。返回 (payload, report_dict)。

    known_axes：同一问题下已登记的争议对象清单，用于让不同回答的 axis 措辞对齐。
    跨回答比对靠 axis 相等来判断「是否在裁决同一件事」，对不齐就退化成词重叠。
    """
    answer_id = item["answer_id"]
    question = item.get("question", "")
    source = item["content"]

    if mock_raw is not None:
        payload, rep = normalize(mock_raw, source, answer_id, question)
        return payload, _rep2dict(rep)

    messages = build_messages(question, source, item.get("author", ""),
                              known_axes=known_axes)
    raw, payload, normalized_report, last_err = None, None, None, None
    for attempt in range(retries + 1):
        try:
            text = call_llm_resilient(messages, verbose=verbose)
        except Exception as e:
            last_err = f"调用失败: {e}"
            break                                # 内层已重试多次，不再叠加外层重试
        raw = parse_json(text)
        if raw is None:
            last_err = "JSON 解析失败"
            messages = messages + [
                {"role": "assistant", "content": text[:2000]},
                {"role": "user", "content": RETRY_HINT_BAD_JSON},
            ]
            continue
        root = raw.get("root")
        if not isinstance(root, dict) or not root.get("statement") or not root.get("children"):
            last_err = "缺少合法观点树"
            messages = messages + [
                {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)[:2000]},
                {"role": "user", "content": RETRY_HINT_INVALID_TREE},
            ]
            continue
        payload, normalized_report = normalize(raw, source, answer_id, question)
        if not normalized_report.ok:
            last_err = normalized_report.fatal or "观点树未通过校验"
            messages = messages + [
                {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)[:3000]},
                {"role": "user", "content": RETRY_HINT_INVALID_TREE + f"\n校验失败原因：{last_err}"},
            ]
            continue
        # 可碰撞层级的统一标准是信息密度。但单篇生成实测约四分钟，一次重试的代价很高，
        # 所以只在**严重**失配时才再要一次（极差 >45 字、比值 >2.6、或多于一个多句话节点）。
        # 轻微偏离目标带只记录在 report 里，不触发重试。
        density = normalized_report.stats.get("density") or {}
        if density.get("severe") and attempt < retries:
            last_err = "collision 信息密度严重失配"
            detail = (
                f"\n实测：字数区间 {density.get('len_min')}～{density.get('len_max')}，"
                f"极差 {density.get('len_spread')}（上限 {density.get('spread_limit')}），"
                f"最长/最短 {density.get('len_ratio')}（上限 {density.get('ratio_limit')}），"
                f"偏离密度带的节点 {len(density.get('off_band_ids') or [])} 个，"
                f"写成多句话的节点 {len(density.get('multi_sentence_ids') or [])} 个。"
            )
            messages = messages + [
                {"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)[:3000]},
                {"role": "user", "content": RETRY_HINT_DENSITY + detail},
            ]
            continue
        break

    if raw is None or payload is None or normalized_report is None or not normalized_report.ok:
        return {}, {"answer_id": answer_id, "ok": False, "fatal": last_err or "未知失败",
                    "dropped": [], "fixed": [], "stats": {}}

    payload["_raw_model_output"] = raw          # 保留原始输出，便于 prompt 迭代对照
    return payload, _rep2dict(normalized_report)


def _rep2dict(rep) -> dict:
    return {"answer_id": rep.answer_id, "ok": rep.ok, "fatal": rep.fatal,
            "dropped": rep.dropped, "fixed": rep.fixed, "stats": rep.stats}


def strip_internal(payload: dict) -> dict:
    """产出给前端的版本：递归去掉 _counter、_raw_model_output 等内部字段。"""
    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if not key.startswith("_")}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    return clean(payload)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="样本 json 路径")
    ap.add_argument("--outdir", default="out", help="结果输出目录")
    ap.add_argument("--mock", nargs="?", const="", default=None,
                    help="离线自测：传入 mock 模型输出 json 路径；"
                         "不带值时默认取样本同目录下的 mock模型输出_脏数据9类.json")
    args = ap.parse_args()

    input_path = Path(args.input)
    items = json.loads(input_path.read_text(encoding="utf-8"))

    mocks = {}
    use_mock = args.mock is not None
    if use_mock:
        mp = Path(args.mock) if args.mock else input_path.parent / "mock模型输出_脏数据9类.json"
        if not mp.exists():
            print(f"[ERR] 找不到 mock 文件: {mp}", file=sys.stderr)
            sys.exit(2)
        mocks = json.loads(mp.read_text(encoding="utf-8"))
        print(f"[mock] 使用离线假输出: {mp}")

    outdir = Path(args.outdir)
    (outdir / "nodes").mkdir(parents=True, exist_ok=True)
    reports = []

    cfg = get_config()
    if not use_mock:
        print(f"[模型] {cfg['model']} @ {cfg['base']}  key={mask(cfg['key'])}")
        print(f"[节流] 每篇间隔 {cfg['sleep']}s（免费档并发受限，串行调用）")
        print(f"[输入] {input_path.name}  共 {len(items)} 篇")
        print("-" * 70)

    t_start = time.time()
    for idx, it in enumerate(items, 1):
        aid = it["answer_id"]
        if not use_mock:
            print(f"[{idx}/{len(items)}] {aid} ({it.get('_clean_chars', len(it['content']))}字) ...",
                  end="", flush=True)
            if idx > 1 and cfg["sleep"] > 0:
                time.sleep(cfg["sleep"])

        t0 = time.time()
        payload, rep = extract_one(it, mock_raw=mocks.get(aid) if use_mock else None,
                                   verbose=not use_mock)
        cost = time.time() - t0
        reports.append(rep)

        if not rep["ok"]:
            print(f"\r[FAIL] {aid}: {rep['fatal']}" + " " * 20, file=sys.stderr)
            continue
        (outdir / "nodes" / f"{aid}.json").write_text(
            json.dumps(strip_internal(payload), ensure_ascii=False, indent=2), encoding="utf-8")
        (outdir / "nodes" / f"{aid}.debug.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        s = rep["stats"]
        prefix = "\r" if not use_mock else ""
        print(f"{prefix}[OK] {aid}  groups={s.get('group_count')} nodes={s.get('node_count')} "
              f"dropped={s.get('dropped_count')} scope空={s.get('scope_empty_rate')} "
              f"({cost:.1f}s)")

    (outdir / "report.json").write_text(
        json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")

    ok = [r for r in reports if r["ok"]]
    if not use_mock:
        print("-" * 70)
        print(f"完成 {len(ok)}/{len(reports)} 篇，耗时 {time.time() - t_start:.0f}s")
        if len(ok) < len(reports):
            print(f"[!] {len(reports) - len(ok)} 篇失败，详见 report.json 的 fatal 字段")
    print(f"\n报告已写入 {outdir / 'report.json'}")


if __name__ == "__main__":
    main()
