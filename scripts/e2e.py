#!/usr/bin/env python3
"""
端到端验收脚本（只用标准库）。

它验证的是【业务流程】，而不是单元行为：
    新建并保存 agent → 从 MySQL 读回确认 → 修改并保存 → 运行 →
    事件流逐条校验 → MySQL 里核对事件与消息 → 断点续传 → 失败路径收敛

用法： scripts/e2e.sh            （会先把三个服务拉起来）
      python3 scripts/e2e.py     （假定服务已在运行）
退出码 0 = 全部通过。
"""
from __future__ import annotations

import http.client
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

SERVER = os.environ.get("E2E_SERVER", "http://127.0.0.1:8080")
HOST = SERVER.split("//", 1)[1]
DB_SH = os.environ.get("E2E_DB_SH", "")
DB_NAME = os.environ.get("AGENT_STACK_DB_NAME", "agent_stack")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
_passed = 0
_failed: list[str] = []


def check(description: str, condition: bool, detail: str = "") -> bool:
    global _passed
    if condition:
        _passed += 1
        print(f"  {GREEN}✔{RESET} {description}")
        return True
    _failed.append(description)
    print(f"  {RED}✘{RESET} {description}")
    if detail:
        print(f"      {DIM}{detail}{RESET}")
    return False


def section(title: str) -> None:
    print(f"\n{YELLOW}▌ {title}{RESET}")


# --------------------------------------------------------------------------- HTTP
def http_json(method: str, path: str, body: Any = None) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        SERVER + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, raw


def read_sse(run_id: str, after_seq: int | None = None, timeout: float = 60.0) -> list[dict]:
    """读一次 run 的 SSE 事件流直到服务端收口。"""
    path = f"/api/runs/{run_id}/events"
    if after_seq is not None:
        path += f"?afterSeq={after_seq}"
    connection = http.client.HTTPConnection(HOST, timeout=timeout)
    connection.request("GET", path, headers={"Accept": "text/event-stream"})
    response = connection.getresponse()
    if response.status != 200:
        connection.close()
        raise RuntimeError(f"SSE 返回 {response.status}")

    events: list[dict] = []
    data_buffer: list[str] = []
    while True:
        line = response.readline()
        if not line:
            break
        text = line.decode("utf-8", "replace").rstrip("\n")
        if text.startswith("data:"):
            data_buffer.append(text[5:].strip())
        elif text == "" and data_buffer:
            events.append(json.loads("\n".join(data_buffer)))
            data_buffer.clear()
    connection.close()
    if data_buffer:
        events.append(json.loads("\n".join(data_buffer)))
    return events


def mysql_query(sql: str) -> list[list[str]]:
    """通过项目自带的 MySQL 客户端查库，直接证明数据真的落到了 MySQL。"""
    result = subprocess.run(
        ["bash", DB_SH, "app-cli", "-N", "-B", "-e", sql, DB_NAME],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"查询失败: {result.stderr.strip()}")
    return [line.split("\t") for line in result.stdout.strip().split("\n") if line.strip()]


# --------------------------------------------------------------------------- fixtures
def graph_with_tools(prompt_template: str = "请帮我算一下：{{input.topic}}") -> dict:
    return {
        "schemaVersion": 1,
        "nodes": [
            {
                "id": "n1",
                "type": "start",
                "position": {"x": 0, "y": 140},
                "data": {
                    "label": "开始",
                    "config": {
                        "inputVariables": [
                            {"name": "topic", "type": "string", "required": True,
                             "description": "本轮要处理的内容"}
                        ]
                    },
                },
            },
            {
                "id": "n2",
                "type": "prompt",
                "position": {"x": 260, "y": 140},
                "data": {"label": "提示词", "config": {"role": "human", "template": prompt_template}},
            },
            {
                "id": "n3",
                "type": "llm",
                "position": {"x": 520, "y": 140},
                "data": {
                    "label": "大模型",
                    "config": {
                        "system": "需要算术时调用 calculator 工具。",
                        "temperature": 0.2,
                        "tools": ["calculator"],
                        "maxSteps": 6,
                        "outputKey": "answer",
                    },
                },
            },
            {
                "id": "n4",
                "type": "end",
                "position": {"x": 780, "y": 140},
                "data": {"label": "结束", "config": {"outputKey": "answer"}},
            },
        ],
        "edges": [
            {"id": "e1", "source": "n1", "target": "n2"},
            {"id": "e2", "source": "n2", "target": "n3"},
            {"id": "e3", "source": "n3", "target": "n4"},
        ],
    }


def main() -> int:
    print(f"{YELLOW}Agent Stack 端到端验收{RESET}  server={SERVER}")

    # ---------------------------------------------------------------- 0 就绪检查
    section("0. 服务就绪")
    status, health = http_json("GET", "/actuator/health")
    check("server /actuator/health 返回 UP", status == 200 and health.get("status") == "UP", str(health))

    status, caps = http_json("GET", "/api/capabilities")
    check("server 能连上 runtime", status == 200 and caps.get("runtimeUp") is True, str(caps))
    check(
        "runtime 如实上报模型模式",
        caps.get("modelMode") in ("scripted", "live"),
        f"modelMode={caps.get('modelMode')}",
    )
    print(f"      {DIM}模型: {caps.get('modelName')} ({caps.get('modelMode')}){RESET}")

    # ---------------------------------------------------------------- 1 新建 agent
    section("1. 新建并保存 agent")
    name = f"E2E 验收 agent {int(time.time())}"
    status, created = http_json(
        "POST", "/api/agents",
        {"name": name, "description": "由 scripts/e2e.py 创建", "graph": graph_with_tools()},
    )
    check("POST /api/agents 返回 201", status == 201, str(created)[:200])
    if status != 201:
        return report()
    agent_id = created["id"]
    check("返回的图与提交的一致", created["graph"] == graph_with_tools())
    check("节点数正确", len(created["graph"]["nodes"]) == 4)

    rows = mysql_query(
        f"SELECT name, graph_schema_version, JSON_LENGTH(graph_json, '$.nodes') "
        f"FROM agent WHERE id='{agent_id}'"
    )
    check("MySQL 里真的有一行 agent", len(rows) == 1, str(rows))
    if rows:
        check("名字与节点数落库正确", rows[0][0] == name and rows[0][2] == "4", str(rows[0]))

    # 重名应当被拒绝
    status, conflict = http_json(
        "POST", "/api/agents",
        {"name": name, "description": "", "graph": graph_with_tools()},
    )
    check("重名 agent 返回 409 而不是 500", status == 409, str(conflict)[:200])

    # 非法图应当被拒绝并带可定位的错误
    bad_graph = {
        "schemaVersion": 1,
        "nodes": [
            {"id": "n1", "type": "start", "position": {"x": 0, "y": 0},
             "data": {"config": {"inputVariables": []}}}
        ],
        "edges": [{"id": "e1", "source": "n1", "target": "ghost"}],
    }
    status, rejected = http_json("POST", "/api/agents", {"name": name + " bad", "graph": bad_graph})
    check("非法图被拒绝（400）", status == 400, str(rejected)[:200])
    check(
        "错误里带 code 与 nodeId，前端能标红到节点上",
        status == 400
        and rejected.get("code") == "INVALID_GRAPH"
        and any(d.get("code") == "EDGE_UNKNOWN_TARGET" for d in rejected.get("details", [])),
        str(rejected)[:300],
    )

    # ---------------------------------------------------------------- 2 修改并保存
    section("2. 修改并重新保存")
    updated_template = "请仔细计算：{{input.topic}}（记得用工具）"
    status, updated = http_json(
        "PUT", f"/api/agents/{agent_id}",
        {"name": name, "description": "已更新", "graph": graph_with_tools(updated_template)},
    )
    check("PUT 保存成功", status == 200, str(updated)[:200])
    template_rows = mysql_query(
        f"SELECT JSON_UNQUOTE(JSON_EXTRACT(graph_json, '$.nodes[1].data.config.template')) "
        f"FROM agent WHERE id='{agent_id}'"
    )
    check(
        "修改后的提示词已落库（不是只改了内存）",
        bool(template_rows) and template_rows[0][0] == updated_template,
        str(template_rows),
    )

    # ---------------------------------------------------------------- 3 运行
    section("3. 运行 agent")
    status, started = http_json(
        "POST", f"/api/agents/{agent_id}/runs", {"input": {"topic": "(12+8)*3"}}
    )
    check("POST /runs 返回 202", status == 202, str(started)[:200])
    if status != 202:
        return report()
    run_id = started["runId"]
    conversation_id = started["conversationId"]
    check("返回 runId 与 conversationId", bool(run_id) and bool(conversation_id))

    events = read_sse(run_id)
    types = [e["type"] for e in events]
    print(f"      {DIM}收到 {len(events)} 条事件{RESET}")
    check("第一个事件是 run.started", types[0] == "run.started", str(types[:3]))
    check("最后一个事件是 run.finished", types[-1] == "run.finished", str(types[-3:]))

    seqs = [e["seq"] for e in events]
    check("seq 从 1 开始且严格递增", seqs == list(range(1, len(events) + 1)), str(seqs[:8]))

    node_started = [e for e in events if e["type"] == "node.started"]
    node_finished = [e for e in events if e["type"] == "node.finished"]
    check("4 个画布节点都宣告了 node.started", len({e["nodeId"] for e in node_started}) == 4)
    check(
        "每个 node.started 都有配对的 node.finished",
        sorted(e["nodeId"] for e in node_started) == sorted(e["nodeId"] for e in node_finished),
        f"started={[e['nodeId'] for e in node_started]} finished={[e['nodeId'] for e in node_finished]}",
    )

    tokens = [e for e in events if e["type"] == "llm.token"]
    streamed = "".join(e["payload"]["delta"] for e in tokens)
    check("有 token 级流式输出（前端才能逐字渲染）", len(tokens) >= 10, f"token 事件 {len(tokens)} 条")

    tool_started = [e for e in events if e["type"] == "tool.started"]
    tool_finished = [e for e in events if e["type"] == "tool.finished"]
    check("发生了一次工具调用", len(tool_started) == 1 and len(tool_finished) == 1)
    if tool_finished:
        check(
            "工具是 calculator 且算出了正确结果",
            tool_finished[0]["payload"]["toolName"] == "calculator"
            and "(12+8)*3 = 60" in tool_finished[0]["payload"]["result"],
            json.dumps(tool_finished[0]["payload"], ensure_ascii=False)[:200],
        )
        check("工具调用没有报错", tool_finished[0]["payload"]["isError"] is False)

    finished = [e for e in events if e["type"] == "run.finished"][0]
    check("run 终态为 SUCCEEDED", finished["payload"]["status"] == "SUCCEEDED", str(finished["payload"])[:200])
    check("run.finished 带回最终答案", bool(finished["payload"].get("answer")))
    check(
        "答案是完整文本而不是片段（与流式拼接一致）",
        finished["payload"]["answer"] == streamed,
        f"answer长度={len(finished['payload'].get('answer') or '')} streamed长度={len(streamed)}",
    )
    totals = finished["payload"].get("totals") or {}
    check(
        "统计信息合理：1 次工具调用、2 次模型调用",
        totals.get("toolCalls") == 1 and totals.get("llmCalls") == 2,
        str(totals),
    )

    # ---------------------------------------------------------------- 4 落库核对
    section("4. MySQL 落库核对")
    if DB_SH:
        event_rows = mysql_query(
            f"SELECT COUNT(*), MIN(seq), MAX(seq), COUNT(DISTINCT seq) "
            f"FROM run_event WHERE run_id='{run_id}'"
        )
        check(
            "run_event 行数与事件流一致，seq 无重复",
            bool(event_rows) and event_rows[0][0] == str(len(events))
            and event_rows[0][1] == "1" and event_rows[0][3] == event_rows[0][0],
            str(event_rows),
        )
        message_rows = mysql_query(
            f"SELECT seq, role, LEFT(content,12) FROM message "
            f"WHERE conversation_id='{conversation_id}' ORDER BY seq"
        )
        check("用户输入与助手回复都落库", len(message_rows) == 3, str(message_rows))
        check(
            "第一条是用户输入",
            bool(message_rows) and message_rows[0][1] == "user" and "(12+8)*3" in message_rows[0][2],
            str(message_rows[:2]),
        )
        run_rows = mysql_query(f"SELECT status FROM run WHERE id='{run_id}'")
        check("run 表终态为 SUCCEEDED", bool(run_rows) and run_rows[0][0] == "SUCCEEDED", str(run_rows))
    else:
        print(f"      {DIM}(未提供 E2E_DB_SH，跳过直连数据库的核对){RESET}")

    status, messages = http_json("GET", f"/api/conversations/{conversation_id}/messages")
    check("通过 API 也能读到会话消息", status == 200 and len(messages) == 3, str(messages)[:200])

    # ---------------------------------------------------------------- 5 断点续传
    section("5. SSE 断点续传")
    tail = read_sse(run_id, after_seq=len(events) - 3)
    check(
        "afterSeq 只回放之后的事件（不丢不重）",
        [e["seq"] for e in tail] == seqs[-3:],
        f"tail={[e['seq'] for e in tail]} expected={seqs[-3:]}",
    )
    full = read_sse(run_id)
    check("不带 afterSeq 时完整回放", [e["seq"] for e in full] == seqs)

    # ---------------------------------------------------------------- 6 失败路径
    section("6. 失败路径也必须收敛")
    status, bad_run = http_json(
        "POST", f"/api/agents/{agent_id}/runs", {"input": {}}
    )
    if status == 202:
        bad_events = read_sse(bad_run["runId"])
        bad_types = [e["type"] for e in bad_events]
        check(
            "缺少必填变量时以 run.error(INVALID_INPUT) 收敛",
            "run.error" in bad_types
            and any(
                e["type"] == "run.error" and e["payload"]["code"] == "INVALID_INPUT" for e in bad_events
            ),
            str(bad_types),
        )
        check("失败 run 依然有终态事件", bad_types[-1] == "run.finished" and bad_events[-1]["payload"]["status"] == "FAILED")
    else:
        check("提交缺少必填变量的 run 被受理", False, f"status={status}")

    status, missing = http_json("GET", "/api/runs/does-not-exist")
    check("不存在的 run 返回 404", status == 404)

    return report()


def report() -> int:
    total = _passed + len(_failed)
    print()
    if _failed:
        print(f"{RED}验收失败{RESET}: {_passed}/{total} 通过")
        for item in _failed:
            print(f"  {RED}·{RESET} {item}")
        return 1
    print(f"{GREEN}验收通过{RESET}: {_passed}/{total} 项全部通过")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - 验收脚本需要把任何异常变成失败
        print(f"\n{RED}验收过程中抛异常{RESET}: {exc!r}")
        sys.exit(1)
