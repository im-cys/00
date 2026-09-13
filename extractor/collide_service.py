# -*- coding: utf-8 -*-
"""碰撞服务：给前端提供 HTTP 接口。

对应 PRD v1.0 §9.1 的「碰撞 API 服务」。

为什么用 Python 起一个独立服务，而不是在 Node 里重写：
    evidence 回查闸门（quote_locator 三级定位 + question_validator 两道关卡）
    已在 401 个节点上实测验证（阈值 0.82，通过率 91.7%，可定位率 100%）。
    在 Node 侧重写等于把已验证的算法重新实现一遍，风险远大于收益。
    因此 Node 只做转发，判定逻辑全部留在 Python。

接口：
    GET  /health              健康检查
    GET  /maps?qid=10002      该问题下所有回答的节点图（含真实归属校正）
    POST /collide             执行一次碰撞

**answer_id 归属校正（重要）**：
    抽取产物的 answer_id 存在真实错位——q3 的 a3–a10、q6 的 a3–a10 整体偏移一位。
    本服务启动时用 quote 回原文反查建立权威映射（与前端 import-maps.mjs 同一思路），
    不修改原始抽取产物，只在内存中纠正。校正后 quote 定位成功率从 72.7% 升到 100%。
"""

from __future__ import annotations

import json
import glob
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from quote_locator import locate_quote          # noqa: E402
from context_pack import build_context_pack     # noqa: E402
from collide_engine import collide              # noqa: E402
from run_extract import load_dotenv, extract_one, strip_internal  # noqa: E402

# 私有内容与抽取产物均由环境变量或 private-data 目录提供，不进入 Git。
PROJECT_ROOT = HERE.parent
load_dotenv(PROJECT_ROOT / ".env")


def _configured_path(value, base):
    path = Path(value)
    return (path if path.is_absolute() else base / path).resolve()


PRIVATE_DATA = _configured_path(os.environ.get("PRIVATE_DATA_DIR", "private-data"), PROJECT_ROOT)
DATA = _configured_path(os.environ.get("COLLISION_DATA_DIR", "collision"), PRIVATE_DATA)

# 前端问题编号 ↔ 抽取产物问题前缀
QID_MAP = {
    "10001": "q1", "10002": "q2", "10003": "q3",
    "10004": "q4", "10005": "q5", "10006": "q6",
}

_LOCK = threading.Lock()
_STORE = {"sources": {}, "answers": {}, "questions": {}, "ready": False, "report": {},
          "to_frontend": {}, "from_frontend": {}}


def to_fe(aid):
    """后端 answer_id → 前端 answer_id。映射缺失时原样返回，便于定位问题。"""
    return _STORE["to_frontend"].get(aid, aid)


def from_fe(aid):
    """前端 answer_id → 后端 answer_id。两种编号都接受。"""
    if aid in _STORE["answers"]:
        return aid
    return _STORE["from_frontend"].get(aid, aid)


# ---------------------------------------------------------------------------
# 数据装载
# ---------------------------------------------------------------------------
def _load_sources():
    """载入标准样本：{answer_id: 清洗后原文}。

    清洗后的文本是唯一的「原文」。char_offset 靠 quote 回原文反查得到，
    若抽取用清洗文本、定位用原始 md，偏移量会整体错位，前端高亮会跳错位置。
    """
    src, meta = {}, {}
    for f in sorted(glob.glob(str(DATA / "测试数据/标准样本/q*_样本.json"))):
        for a in json.load(open(f, encoding="utf-8")):
            src[a["answer_id"]] = a["content"]
            meta[a["answer_id"]] = {
                "author": a.get("author") or "",
                "question": a.get("question") or "",
            }
    return src, meta


def _nodes_dirs():
    """各问题的抽取产物目录。q5 用首轮结果（未重复消耗配额）。"""
    out = {}
    for qid, q in QID_MAP.items():
        if q == "q5":
            d = DATA / "实测报告/20260912_q5_真实首轮/nodes"
        else:
            d = DATA / f"实测报告/20260912_全量6问题/{q}/nodes"
        if d.is_dir():
            out[q] = d
    return out


def _resolve_owner(payload, sources, prefix):
    """用 quote 回原文反查真实归属的 answer_id。

    不信任产物里自报的 answer_id——q3/q6 存在整体偏移一位的真实错位。
    判据：命中最多且明显领先者胜出；无 quote 可验证时回退自报值。
    """
    quotes = [n.get("quote") for n in payload.get("nodes", []) if n.get("quote")]
    claimed = payload.get("answer_id")
    if not quotes:
        return claimed, 0, len(quotes), "self_reported"
    best, best_hits, runner = claimed, -1, 0
    for aid, text in sources.items():
        if not aid.startswith(prefix + "_"):
            continue
        hits = sum(1 for q in quotes if locate_quote(text, q, threshold=0.82))
        if hits > best_hits:
            runner, best, best_hits = best_hits, aid, hits
        elif hits > runner:
            runner = hits
    if best_hits > 0 and best_hits > runner:
        return best, best_hits, len(quotes), "quote_verified"
    return claimed, max(best_hits, 0), len(quotes), "self_reported"


def _frontend_texts():
    """读取前端 data.js 中每篇回答的展示正文：{frontend_id: text}。

    前端页面渲染的是 data.js，抽取用的是标准样本。两份文本内容一致但
    回答编号体系不同（10002-09 vs q2_a9），且抽取产物存在整体错位。
    因此不能靠下标推算映射，必须用 quote 回正文反查。
    """
    import subprocess
    data_file = PRIVATE_DATA / "data.js"
    script = (
        'const {readFileSync}=require("fs");const vm=require("vm");'
        'const ctx={window:{}};'
        f'vm.runInNewContext(readFileSync({json.dumps(str(data_file))},"utf8"),ctx);'
        'const o={};for(const q of ctx.window.ZHIHU_DEMO_DATA.questions)for(const a of q.answers)'
        'o[a.id]=a.paragraphs.filter(p=>!p.includes("〔图片〕")&&!p.includes("〔视频〕")).join("");'
        'process.stdout.write(JSON.stringify(o));'
    )
    try:
        out = subprocess.run(["node", "-e", script], capture_output=True,
                             text=True, encoding="utf-8", timeout=60)
        return json.loads(out.stdout) if out.stdout else {}
    except Exception:
        return {}


def _squeeze(s):
    return re.sub(r"\s", "", s or "")


def _build_frontend_map(answers):
    """用 quote 在前端正文中反查，建立 后端 answer_id ↔ 前端 answer_id 映射。

    与前端 import-maps.mjs 同一思路，保证两端指向同一篇回答。
    """
    fe = _frontend_texts()
    if not fe:
        return {}, {}
    qid_of = {v: k for k, v in QID_MAP.items()}
    fwd = {}
    for aid, a in answers.items():
        quotes = [_squeeze(n.get("quote")) for n in a["nodes"] if n.get("quote")]
        if not quotes:
            continue
        prefix = qid_of.get(aid.split("_")[0])
        best, best_hits = None, 0
        for feid, text in fe.items():
            if prefix and not feid.startswith(prefix):
                continue
            t = _squeeze(text)
            hits = sum(1 for q in quotes if q in t)
            if hits > best_hits:
                best, best_hits = feid, hits
        if best and best_hits:
            fwd[aid] = best
    return fwd, {v: k for k, v in fwd.items()}


def load_all():
    """装载全部数据并建立权威映射。启动时执行一次。"""
    sources, meta = _load_sources()
    answers, report = {}, {"shifted": [], "skipped": [], "quote_ok": 0, "quote_miss": 0}

    for q, d in _nodes_dirs().items():
        claimed_map = {}
        for f in sorted(glob.glob(str(d / "*.json"))):
            if ".debug." in os.path.basename(f):
                continue
            payload = json.load(open(f, encoding="utf-8"))
            owner, hits, total, method = _resolve_owner(payload, sources, q)
            if owner not in sources:
                report["skipped"].append(f"{payload.get('answer_id')}：无对应原文，跳过")
                continue
            if owner != payload.get("answer_id"):
                report["shifted"].append(f"{payload.get('answer_id')} → {owner}")
            # 同一回答被两份产物指向时，保留验证命中更多的那份，不静默覆盖
            prev = claimed_map.get(owner)
            if prev and prev["hits"] >= hits:
                report["skipped"].append(
                    f"{payload.get('answer_id')} 与 {prev['legacy']} 都指向 {owner}，保留 {prev['legacy']}")
                continue
            claimed_map[owner] = {"payload": payload, "hits": hits, "total": total,
                                  "legacy": payload.get("answer_id"), "method": method}

        for owner, item in claimed_map.items():
            payload = item["payload"]
            text = sources[owner]
            nodes = []
            for n in payload.get("nodes", []):
                qt = n.get("quote")
                loc = locate_quote(text, qt, threshold=0.82) if qt else None
                if qt:
                    if loc:
                        report["quote_ok"] += 1
                    else:
                        report["quote_miss"] += 1
                nodes.append({**n,
                              "answer_id": owner,
                              # offset 一律按当前原文重算，不沿用产物里的旧值
                              "char_offset": loc.start if loc else None,
                              "grounded": bool(loc) if qt else False})
            answers[owner] = {
                "answer_id": owner,
                "legacy_id": item["legacy"],
                "mapping": item["method"],
                "author": meta.get(owner, {}).get("author", ""),
                "question": meta.get(owner, {}).get("question", ""),
                "groups": payload.get("groups", []),
                "nodes": nodes,
            }

    fwd, rev = _build_frontend_map(answers)

    with _LOCK:
        _STORE["sources"] = sources
        _STORE["answers"] = answers
        _STORE["report"] = report
        _STORE["to_frontend"] = fwd
        _STORE["from_frontend"] = rev
        _STORE["ready"] = True
    report["frontend_mapped"] = len(fwd)
    return report


# ---------------------------------------------------------------------------
# 业务
# ---------------------------------------------------------------------------
def maps_for(qid: str) -> dict:
    """返回某问题下全部回答的节点图（供前端渲染结构图）。"""
    prefix = QID_MAP.get(str(qid))
    if not prefix:
        return {"error": f"未知问题编号 {qid}"}
    out = {}
    for aid, a in _STORE["answers"].items():
        if not aid.startswith(prefix + "_"):
            continue
        feid = to_fe(aid)
        out[feid] = {
            "answerId": feid,
            "backendId": aid,
            "legacyId": a["legacy_id"],
            "mapping": a["mapping"],
            "author": a["author"],
            "groups": a["groups"],
            "nodes": [{
                "id": n.get("id"),
                "groupId": n.get("group_id"),
                "role": n.get("role"),
                "text": n.get("claim_text"),
                "type": n.get("type"),
                "polarity": n.get("polarity"),
                "scope": n.get("scope"),
                "quote": n.get("quote"),
                "charOffset": n.get("char_offset"),
                "grounded": n.get("grounded"),
            } for n in a["nodes"]],
        }
    return {"questionId": str(qid), "answers": out}


def _find(aid, nid):
    a = _STORE["answers"].get(aid)
    if not a:
        return None, None
    n = next((x for x in a["nodes"] if x.get("id") == nid), None)
    return a, n


def _map_node_to_backend(node, answer_id, source):
    """把网页使用的 camelCase 节点恢复为碰撞管道使用的字段。"""
    quote = node.get("quote") or ""
    loc = locate_quote(source, quote, threshold=0.82) if quote else None
    return {
        "id": node.get("id"),
        "answer_id": answer_id,
        "group_id": node.get("group_id", node.get("groupId")),
        "role": node.get("role"),
        "claim_text": node.get("claim_text", node.get("text")),
        "type": node.get("type"),
        "polarity": node.get("polarity"),
        "scope": node.get("scope"),
        "quote": quote or None,
        "char_offset": loc.start if loc else node.get("char_offset", node.get("charOffset")),
        "grounded": bool(loc) if quote else False,
    }


def _context_answers(body):
    answers = []
    for context in body.get("answerContexts") or []:
        answer_id = str(context.get("answerId") or "")
        source = str(context.get("content") or "")
        payload = context.get("map") or {}
        groups = []
        for group in payload.get("groups") or []:
            groups.append({
                **group,
                "group_id": group.get("group_id", group.get("id", group.get("groupId"))),
                "start_offset": group.get("start_offset", group.get("startOffset")),
            })
        nodes = [_map_node_to_backend(node, answer_id, source)
                 for node in payload.get("nodes") or []]
        answers.append({
            "answer_id": answer_id,
            "legacy_id": answer_id,
            "author": context.get("author") or payload.get("author") or "",
            "question": context.get("questionTitle") or "",
            "groups": groups,
            "nodes": nodes,
            "source": source,
        })
    return answers


def extract_map(body: dict) -> dict:
    answer_id = str(body.get("answerId") or "")
    content = str(body.get("content") or "")
    if not answer_id or not content:
        return {"error": "answerId 和 content 均为必填项"}
    payload, report = extract_one({
        "answer_id": answer_id,
        "question": str(body.get("questionTitle") or ""),
        "content": content,
        "author": str(body.get("author") or ""),
    }, verbose=False)
    if not report.get("ok"):
        return {"error": report.get("fatal") or "节点抽取未通过校验"}
    payload = strip_internal(payload)
    frontend = {
        "answerId": answer_id,
        "backendId": answer_id,
        "legacyId": answer_id,
        "mapping": "database_generated",
        "author": body.get("author") or "",
        "groups": payload.get("groups") or [],
        "nodes": [{
            "id": node.get("id"),
            "groupId": node.get("group_id"),
            "role": node.get("role"),
            "text": node.get("claim_text"),
            "type": node.get("type"),
            "polarity": node.get("polarity"),
            "scope": node.get("scope"),
            "quote": node.get("quote"),
            "charOffset": node.get("char_offset"),
            "grounded": node.get("grounded"),
        } for node in payload.get("nodes") or []],
    }
    return {"map": frontend, "report": report}


def do_collide(body: dict) -> dict:
    """执行一次碰撞。入口层只做「明显不可碰」的校验（PRD §5.1 第 1 层，宽松）。"""
    refs = body.get("refs") or []
    if len(refs) != 2:
        return {"status": "blocked", "reason": "需要恰好两个节点"}

    supplied = _context_answers(body)
    if supplied:
        by_id = {answer["answer_id"]: answer for answer in supplied}
        pairs = []
        for ref in refs:
            answer = by_id.get(str(ref.get("answerId") or ""))
            node = next((item for item in (answer or {}).get("nodes", [])
                         if item.get("id") == ref.get("nodeId")), None)
            pairs.append((answer, node))
        (a1, n1), (a2, n2) = pairs
    else:
        (a1, n1), (a2, n2) = [_find(from_fe(r.get("answerId")), r.get("nodeId")) for r in refs]
    if not (a1 and n1 and a2 and n2):
        return {"status": "blocked", "reason": "节点不存在或未被抽取"}
    if a1["answer_id"] == a2["answer_id"]:
        return {"status": "blocked", "reason": "两个节点必须来自不同的回答"}

    source_a = a1.get("source") or _STORE["sources"][a1["answer_id"]]
    source_b = a2.get("source") or _STORE["sources"][a2["answer_id"]]
    pa = build_context_pack(n1, source_a, a1["groups"],
                            author=a1["author"], all_nodes=a1["nodes"])
    pb = build_context_pack(n2, source_b, a2["groups"],
                            author=a2["author"], all_nodes=a2["nodes"])

    title = body.get("questionTitle") or a1["question"] or ""
    sources = {a1["answer_id"]: source_a, a2["answer_id"]: source_b}

    result = collide(title, pa, pb, sources, verbose=False)
    result.pop("_raw", None)   # 原始输出不回传前端，避免泄露 prompt 细节
    # evidence 里的 answer_id 换成前端编号，便于前端直接定位到对应回答卡片
    for e in result.get("evidence_located", []):
        e["backend_answer_id"] = e.get("answer_id")
        e["answer_id"] = e.get("answer_id") if supplied else to_fe(e.get("answer_id"))
    result["refs"] = [
        {"answerId": a1["answer_id"] if supplied else to_fe(a1["answer_id"]), "backendId": a1["answer_id"], "nodeId": n1.get("id"),
         "author": a1["author"], "claim": n1.get("claim_text"), "quote": n1.get("quote")},
        {"answerId": a2["answer_id"] if supplied else to_fe(a2["answer_id"]), "backendId": a2["answer_id"], "nodeId": n2.get("id"),
         "author": a2["author"], "claim": n2.get("claim_text"), "quote": n2.get("quote")},
    ]
    return result


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[collide] " + (fmt % args) + "\n")

    def _json(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        if u.path == "/health":
            r = _STORE["report"]
            return self._json(200, {
                "ok": _STORE["ready"],
                "app": "collide-service",
                "answers": len(_STORE["answers"]),
                "quoteOk": r.get("quote_ok"),
                "quoteMiss": r.get("quote_miss"),
                "shifted": len(r.get("shifted", [])),
            })
        if u.path == "/maps":
            qid = (parse_qs(u.query).get("qid") or [""])[0]
            return self._json(200, maps_for(qid))
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/collide", "/extract-map"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 2 * 1024 * 1024:
                return self._json(400, {"error": "请求体为空或过大"})
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as exc:
            return self._json(400, {"error": f"请求解析失败：{exc}"})
        try:
            result = extract_map(body) if self.path == "/extract-map" else do_collide(body)
            return self._json(400 if result.get("error") else 200, result)
        except Exception as exc:
            # 兜底：任何异常都转成可渲染结构，前端不会拿到裸 500
            return self._json(200, {"status": "blocked", "reason": f"服务内部错误：{exc}"})


def main():
    import argparse
    ap = argparse.ArgumentParser(description="碰撞服务（供前端调用）")
    ap.add_argument("--port", type=int, default=3311)
    ap.add_argument("--host", default=os.environ.get("COLLIDE_HOST", "127.0.0.1"))
    args = ap.parse_args()

    print("装载抽取产物与原文 ...", flush=True)
    r = load_all()
    print(f"  回答数 {len(_STORE['answers'])}"
          f" | quote 可定位 {r['quote_ok']} 失败 {r['quote_miss']}", flush=True)
    if r["shifted"]:
        print(f"  按 quote 校正归属 {len(r['shifted'])} 处：{'、'.join(r['shifted'][:6])}"
              + (" …" if len(r["shifted"]) > 6 else ""), flush=True)
    for s in r["skipped"]:
        print("  " + s, flush=True)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"碰撞服务已启动 http://{args.host}:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
