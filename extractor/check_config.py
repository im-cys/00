# -*- coding: utf-8 -*-
"""模型访问配置自检。

填完 .env 后先跑这个，确认配置可用再跑真实抽取。
全程只显示脱敏后的 Key 片段，不会打印完整凭据。

用法：
    python check_config.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from run_extract import get_config, load_dotenv, mask, parse_json

BAR = "-" * 58


def main() -> int:
    print(BAR)
    print("模型访问配置自检")
    print(BAR)

    loaded = load_dotenv()
    cfg = get_config()
    src = ".env 文件" if loaded else "系统环境变量"

    print(f"配置来源   {src}")
    print(f"BASE_URL   {cfg['base']}")
    print(f"MODEL      {cfg['model']}")
    print(f"API_KEY    {mask(cfg['key'])}")
    print()

    if not cfg["key"]:
        print("[X] 缺少 EXTRACT_API_KEY。")
        # 常见误操作：把 Key 填进了模板文件 .env.example
        example = Path(__file__).resolve().parent.parent / ".env.example"
        if example.exists():
            for line in example.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if s.startswith("EXTRACT_API_KEY=") and len(s.split("=", 1)[1].strip()) > 8:
                    print()
                    print("    [!] 检测到你把 Key 填进了 .env.example（模板文件）。")
                    print("        模板文件不会被代码读取，也不受 .gitignore 保护。")
                    print("        请把 Key 移到同目录的 .env 文件中，并清空模板里的值。")
                    return 2
        print("    请把 Key 填入 代码/.env 的 EXTRACT_API_KEY=")
        print("    （该文件已创建好，直接编辑即可；它已被 .gitignore 忽略）")
        return 2

    try:
        import requests
    except ImportError:
        print("[X] 缺少 requests 依赖，请执行： pip install requests")
        return 2

    def post(extra_body: dict, timeout: int = 90):
        """统一请求。必须与 run_extract.call_llm 使用相同的 body 构造逻辑，
        否则自检通过但实际抽取失败（或反之）。

        实测：glm-4.7-flash 不关思考链时会直接返回 429「访问量过大」，
        关闭后 0.6s 正常返回。所以 thinking 参数必须带上。
        """
        body = {"model": cfg["model"], "messages": extra_body.pop("messages")}
        body.update(extra_body)
        if "glm" in cfg["model"].lower():
            body["thinking"] = {"type": "disabled"}
        return requests.post(
            f"{cfg['base']}/chat/completions",
            headers={"Authorization": f"Bearer {cfg['key']}",
                     "Content-Type": "application/json"},
            json=body, timeout=timeout,
        )

    # ---- 1. 连通性 + 鉴权 ----
    print("[1/3] 测试连通性与鉴权 ...")
    try:
        r = post({"messages": [{"role": "user", "content": "只回复两个字：正常"}],
                  "max_tokens": 20})
    except Exception as e:
        print(f"      [X] 网络请求失败：{type(e).__name__}: {e}")
        print("      检查 BASE_URL 是否正确、是否需要代理。")
        return 1

    if r.status_code == 401:
        print("      [X] 401 鉴权失败：API Key 无效或已过期。")
        return 1
    if r.status_code == 404:
        print(f"      [X] 404：模型名 {cfg['model']} 不存在，或 BASE_URL 路径不对。")
        print("      注意 BASE_URL 通常要以 /v1 结尾，且不要自己带 /chat/completions。")
        return 1
    if r.status_code == 429:
        print("      [!] 429 限流。免费档并发受限，稍后重试；")
        print("          若持续 429，把 .env 里的 EXTRACT_SLEEP 调大（如 3.0）。")
        return 1
    if r.status_code != 200:
        print(f"      [X] HTTP {r.status_code}: {r.text[:300]}")
        return 1

    try:
        reply = r.json()["choices"][0]["message"]["content"]
    except Exception:
        print(f"      [X] 响应结构异常：{r.text[:300]}")
        return 1
    print(f"      [OK] 连通，模型回复：{reply.strip()[:40]}")

    # ---- 2. JSON 模式（抽取模块强依赖）----
    print("[2/3] 测试 json_object 响应模式 ...")
    try:
        time.sleep(cfg.get("sleep", 1.5))
        r2 = post({"messages": [{"role": "user",
                                 "content": '输出JSON：{"ok":true,"n":[1,2]}'}],
                   "response_format": {"type": "json_object"},
                   "max_tokens": 60})
        if r2.status_code != 200:
            print(f"      [!] 不支持 response_format（HTTP {r2.status_code}）。")
            print("      抽取仍可运行：代码里有去围栏 + 截取 JSON 的兜底，但稳定性下降。")
        elif parse_json(r2.json()["choices"][0]["message"]["content"]) is None:
            print("      [!] 返回内容无法解析为 JSON，将依赖代码兜底。")
        else:
            print("      [OK] 支持 JSON 模式")
    except Exception as e:
        print(f"      [!] 测试异常：{e}，不阻塞。")

    # ---- 3. 中文长文本承载 ----
    print("[3/3] 测试中文逐字摘录 ...")
    try:
        time.sleep(cfg.get("sleep", 1.5))
        r3 = post({"messages": [{"role": "user",
                                 "content": "这是一段中文测试。请逐字重复引号内的内容："
                                            "「普通家庭的孩子，不建议读博。」"}],
                   "max_tokens": 60})
        out = r3.json()["choices"][0]["message"]["content"]
        if "不建议读博" in out:
            print("      [OK] 中文逐字摘录正常（quote 定位依赖此能力）")
        else:
            print(f"      [!] 逐字重复不准确：{out.strip()[:60]}")
            print("      quote 定位可能更多走模糊匹配，注意 report 里的 fuzzy 计数。")
    except Exception as e:
        print(f"      [!] 测试异常：{e}，不阻塞。")

    print()
    print(BAR)
    print("自检通过，可以跑真实抽取：")
    print('  BS="../private-data/collision"')
    print('  python run_extract.py --input "$BS/测试数据/样本_读博_对立双篇.json" \\')
    print('                        --outdir "$BS/实测报告/日期_实验名"')
    print(BAR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
