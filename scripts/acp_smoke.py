#!/usr/bin/env python3
"""CV6 live wire smoke for SPEC-HC-005 Phase 1 against real `agy acp`.

Starts `hitl-channel` daemon mode (`bun run src/daemon.ts --harness agy`),
pairs a simulated phone WS/HTTP client, and verifies on the live wire:
  1. Session 1: HTTP MCP bearer auth + tool round-trip + auto-allow (0 choices frames)
     + HITL_DAEMON_SESSION stop-hook skip marker.
  2. Session 2: Second ACP session via stateless loopback MCP (0 choices frames).
  3. /sessions + /resume <session1_id> with re-injected MCP (0 choices frames).
  4. Non-hitl tool permission round-trip (`choices` card -> Allow -> command runs).
  5. SIGTERM shuts down daemon cleanly and terminates the child process group <= 5s.
"""
from __future__ import annotations

import argparse
import base64
import glob
import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


def find_bun(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    from_path = shutil.which("bun")
    if from_path:
        return from_path
    candidates = sorted(glob.glob("/nix/store/*-bun-*/bin/bun"))
    if candidates:
        return candidates[-1]
    raise RuntimeError("bun binary not found in PATH or /nix/store/*-bun-*/bin/bun")


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def http_json(
    url: str,
    method: str = "GET",
    body: dict | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req_headers = {"Accept": "application/json"}
    if data is not None:
        req_headers["Content-Type"] = "application/json"
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {"raw": raw}
        return err.code, parsed


class MinimalWsClient:
    """Zero-dependency RFC 6455 WebSocket text client over TCP."""

    def __init__(self, host: str, port: int, path: str) -> None:
        self._sock = socket.create_connection((host, port), timeout=10.0)
        self._sock.settimeout(None)
        self._send_lock = threading.Lock()
        self._closed = False
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(handshake.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RuntimeError("WS handshake closed prematurely")
            buf += chunk
        header_bytes, rest = buf.split(b"\r\n\r\n", 1)
        status_line = header_bytes.decode("latin-1").split("\r\n", 1)[0]
        if "101" not in status_line:
            raise RuntimeError(f"WS upgrade failed: {status_line}")
        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if expected_accept.lower() not in header_bytes.decode("latin-1").lower():
            raise RuntimeError("WS Sec-WebSocket-Accept mismatch")
        self._prebuffer = bytearray(rest)

    def _recv_exact(self, n: int) -> bytes:
        out = bytearray()
        if self._prebuffer:
            take = min(n, len(self._prebuffer))
            out.extend(self._prebuffer[:take])
            del self._prebuffer[:take]
        while len(out) < n:
            chunk = self._sock.recv(n - len(out))
            if not chunk:
                raise EOFError("WS connection closed")
            out.extend(chunk)
        return bytes(out)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x80 | (opcode & 0x0F)])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._send_lock:
            if not self._closed:
                self._sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def send_json(self, obj: dict) -> None:
        self.send_text(json.dumps(obj))

    def recv_message(self) -> str | None:
        fragments: list[bytes] = []
        current_opcode = None
        while True:
            b1, b2 = self._recv_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask_key = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length)
            if masked:
                payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

            if opcode == 0x8:  # close
                return None
            if opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode != 0x0:
                current_opcode = opcode
                fragments = [payload]
            else:
                fragments.append(payload)
            if fin:
                data = b"".join(fragments)
                if current_opcode == 0x1:
                    return data.decode("utf-8")
                fragments = []
                current_opcode = None

    def close(self) -> None:
        self._closed = True
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self._sock.close()
        except Exception:
            pass


def list_descendants_and_child_pgids(root_pid: int) -> tuple[list[int], set[int]]:
    """Return all recursive descendant PIDs of root_pid and detached child PGIDs."""
    out = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid="], text=True)
    children_by_ppid: dict[int, list[int]] = {}
    pgid_by_pid: dict[int, int] = {}
    for line in out.splitlines():
        parts = line.strip().split()
        if len(parts) != 3:
            continue
        pid, ppid, pgid = int(parts[0]), int(parts[1]), int(parts[2])
        children_by_ppid.setdefault(ppid, []).append(pid)
        pgid_by_pid[pid] = pgid

    root_pgid = pgid_by_pid.get(root_pid)
    descendants: list[int] = []
    child_pgids: set[int] = set()
    stack = list(children_by_ppid.get(root_pid, []))
    seen: set[int] = set()
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        descendants.append(cur)
        cpgid = pgid_by_pid.get(cur)
        if cpgid is not None and cpgid != root_pgid:
            child_pgids.add(cpgid)
        stack.extend(children_by_ppid.get(cur, []))
    return descendants, child_pgids


def find_live_pids_in_pgids(pgids: set[int]) -> list[int]:
    """Return any live PIDs still belonging to one of pgids."""
    if not pgids:
        return []
    out = subprocess.check_output(["ps", "-axo", "pid=,pgid="], text=True)
    live: list[int] = []
    for line in out.splitlines():
        parts = line.strip().split()
        if len(parts) != 2:
            continue
        pid, pgid = int(parts[0]), int(parts[1])
        if pgid in pgids:
            live.append(pid)
    return live


def wait_for_reply(
    q: queue.Queue[dict],
    predicate=None,
    timeout: float = 120.0,
) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = max(0.1, deadline - time.time())
        try:
            frame = q.get(timeout=min(1.0, remaining))
        except queue.Empty:
            continue
        if predicate is None or predicate(frame):
            return frame
    raise TimeoutError(f"Timed out waiting for reply after {timeout}s")


def main() -> int:
    parser = argparse.ArgumentParser(description="CV6 live wire smoke against real ACP harnesses")
    parser.add_argument(
        "--harness",
        choices=["agy", "codex", "hermes"],
        default="agy",
        help="ACP harness to test (default: agy)",
    )
    parser.add_argument(
        "--mcp-transport",
        choices=["auto", "http", "stdio"],
        default="auto",
        help="MCP injection transport for daemon mode (default: auto)",
    )
    parser.add_argument(
        "--handshake-only",
        action="store_true",
        help="Verify daemon boot, /new, /sessions, /resume, and SIGTERM cleanup without running an LLM prompt turn",
    )
    parser.add_argument("--bun", help="Path to bun executable")
    parser.add_argument("--timeout", type=float, default=120.0, help="Per-turn timeout in seconds")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    bun_bin = find_bun(args.bun)
    port = pick_free_port()
    api_key = f"smoke-key-{secrets.token_hex(12)}"

    tmpdir = Path(tempfile.mkdtemp(prefix="hitl-acp-smoke-"))
    identity_file = tmpdir / "identity-smoke.json"
    hook_debug_file = tmpdir / "hook_debug.log"
    perm_target_file = Path(f"/tmp/hitl_acp_smoke_{os.getpid()}_{secrets.token_hex(4)}.txt")

    tokens = {
        "smoke_ping": f"TOKEN-S1-{secrets.token_hex(4)}",
        "smoke_ping_2": f"TOKEN-S2-{secrets.token_hex(4)}",
        "smoke_ping_resume": f"TOKEN-RES-{secrets.token_hex(4)}",
    }
    phone_tools = [
        {
            "name": "smoke_ping",
            "description": "Smoke tool 1 returning a unique verification token.",
            "inputSchema": {"type": "object", "properties": {}},
            "tier": "free",
        },
        {
            "name": "smoke_ping_2",
            "description": "Smoke tool 2 returning a unique verification token.",
            "inputSchema": {"type": "object", "properties": {}},
            "tier": "free",
        },
        {
            "name": "smoke_ping_resume",
            "description": "Smoke tool 3 returning a unique verification token.",
            "inputSchema": {"type": "object", "properties": {}},
            "tier": "free",
        },
    ]

    env = os.environ.copy()
    env["HITL_CHANNEL_API_KEY"] = api_key
    env["HITL_CHANNEL_IDENTITY_FILE"] = str(identity_file)
    env["HITL_HOOK_DEBUG"] = "1"
    env["HITL_HOOK_DEBUG_FILE"] = str(hook_debug_file)
    env["NODE_ENV"] = "production"
    env.pop("BUN_ENV", None)
    if args.harness == "codex" and not args.handshake_only:
        # codex-acp defaults to `agent` (auto-review), which executes `/tmp` writes without
        # raising `session/request_permission`; `read-only` routes writes to phone approvals.
        env.setdefault("INITIAL_AGENT_MODE", "read-only")

    stderr_lines: list[str] = []
    daemon_proc = subprocess.Popen(
        [
            bun_bin,
            "run",
            "src/daemon.ts",
            "--harness",
            args.harness,
            "--mcp-transport",
            args.mcp_transport,
            "--port",
            str(port),
            "--cwd",
            "/tmp",
        ],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def pump_stream(stream, sink: list[str] | None, prefix: str) -> None:
        for line in stream:
            if sink is not None:
                sink.append(line)
                if len(sink) > 200:
                    del sink[:50]
            sys.stderr.write(f"{prefix}{line}")

    threading.Thread(target=pump_stream, args=(daemon_proc.stdout, None, "[daemon:out] "), daemon=True).start()
    threading.Thread(target=pump_stream, args=(daemon_proc.stderr, stderr_lines, "[daemon:err] "), daemon=True).start()

    ws: MinimalWsClient | None = None
    replies: queue.Queue[dict] = queue.Queue()
    choices_frames: queue.Queue[dict] = queue.Queue()
    tool_calls_seen: list[str] = []

    try:
        base_url = f"http://127.0.0.1:{port}"
        deadline = time.time() + 15.0
        while time.time() < deadline:
            if daemon_proc.poll() is not None:
                raise RuntimeError(f"Daemon exited early with {daemon_proc.returncode}")
            try:
                status, body = http_json(f"{base_url}/health")
                if status == 200 and body.get("status") == "ok":
                    break
            except Exception:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("Daemon /health timed out")

        ws = MinimalWsClient("127.0.0.1", port, f"/ws?token={api_key}")

        def ws_reader() -> None:
            assert ws is not None
            while True:
                try:
                    raw = ws.recv_message()
                except Exception:
                    return
                if raw is None:
                    return
                try:
                    frame = json.loads(raw)
                except Exception:
                    continue
                ftype = frame.get("type")
                if ftype == "reply":
                    if frame.get("id"):
                        ws.send_json({"type": "ack", "id": frame["id"]})
                    replies.put(frame)
                elif ftype == "choices":
                    choices_frames.put(frame)
                elif ftype == "list_tools_request":
                    ws.send_json({
                        "type": "list_tools_result",
                        "request_id": frame["request_id"],
                        "tools": phone_tools,
                    })
                elif ftype == "tool_call_request":
                    tname = frame.get("name", "")
                    tool_calls_seen.append(tname)
                    token = tokens.get(tname, "UNKNOWN-TOOL")
                    ws.send_json({
                        "type": "tool_call_result",
                        "request_id": frame["request_id"],
                        "success": True,
                        "approval": "auto",
                        "output": token,
                    })

        threading.Thread(target=ws_reader, daemon=True).start()
        auth_headers = {"Authorization": f"Bearer {api_key}"}

        def post_msg(payload: dict) -> None:
            st, res = http_json(f"{base_url}/", method="POST", body=payload, headers=auth_headers)
            if st != 200 or res.get("status") != "delivered":
                raise RuntimeError(f"POST / failed: status={st} body={res}")

        def drain_choices() -> list[dict]:
            items = []
            while not choices_frames.empty():
                items.append(choices_frames.get_nowait())
            return items

        # ── Check 1: Session 1 (+ full prompt/MCP check unless --handshake-only) ──────
        print(f"[smoke] Step 1 ({args.harness}/{args.mcp_transport}): /new /tmp")
        post_msg({"message": "/new /tmp"})
        r_new1 = wait_for_reply(replies, lambda f: f"New {args.harness} session" in f.get("text", ""), timeout=args.timeout)
        m1 = re.search(r"\(id ([^)]+)\)", r_new1["text"])
        if not m1:
            raise RuntimeError(f"Could not parse session1 id from: {r_new1['text']}")
        session1_id = m1.group(1)
        print(f"[smoke]   session1_id={session1_id}")

        if args.handshake_only:
            print(f"[smoke] Step 2 (handshake-only): /sessions + /resume {session1_id}")
            post_msg({"message": "/sessions"})
            r_sess = wait_for_reply(
                replies,
                lambda f: "1. " in f.get("text", "") or "No sessions found" in f.get("text", ""),
                timeout=args.timeout,
            )
            print(f"[smoke]   /sessions top line={r_sess['text'].splitlines()[0]!r}")

            post_msg({"message": f"/resume {session1_id}"})
            r_res = wait_for_reply(replies, lambda f: "Resumed" in f.get("text", ""), timeout=args.timeout)
            print(f"[smoke]   /resume reply={r_res['text']!r}")
        else:
            drain_choices()
            post_msg({
                "message": (
                    "Call the hitl-channel MCP tool call_phone_tool with name=\"smoke_ping\" "
                    "and arguments={}. Reply with ONLY the exact token string it returns."
                ),
            })
            r_p1 = wait_for_reply(replies, lambda f: tokens["smoke_ping"] in f.get("text", ""), timeout=args.timeout)
            print(f"[smoke]   session1 reply={r_p1['text']!r}")
            if "smoke_ping" not in tool_calls_seen:
                raise RuntimeError("smoke_ping did not reach simulated phone")
            extra_choices_1 = drain_choices()
            if extra_choices_1:
                raise RuntimeError(f"Expected 0 choices frames for auto-allowed hitl tool, got {extra_choices_1}")
            if hook_debug_file.exists():
                hook_log = hook_debug_file.read_text(encoding="utf-8")
                if args.harness == "agy" and "daemon_session_skip" not in hook_log:
                    raise RuntimeError(f"Hook guard marker missing from {hook_debug_file}: {hook_log!r}")
                print(f"[smoke]   hook debug log lines={len(hook_log.splitlines())}")
            elif args.harness == "agy":
                raise RuntimeError(f"Hook debug file was not created: {hook_debug_file}")
            print("[smoke]   PASS: MCP auth, auto-allow (0 choices), and hook isolation checked")

            # ── Check 2: Session 2 via stateless loopback MCP ────────────────────────────
            print("[smoke] Step 2: /new /tmp + smoke_ping_2 (second sequential session)")
            post_msg({"message": "/new /tmp"})
            r_new2 = wait_for_reply(replies, lambda f: f"New {args.harness} session" in f.get("text", ""), timeout=args.timeout)
            m2 = re.search(r"\(id ([^)]+)\)", r_new2["text"])
            if not m2:
                raise RuntimeError(f"Could not parse session2 id from: {r_new2['text']}")
            session2_id = m2.group(1)
            assert session2_id != session1_id, "Expected distinct session2_id"
            print(f"[smoke]   session2_id={session2_id}")

            drain_choices()
            post_msg({
                "message": (
                    "Call the hitl-channel MCP tool call_phone_tool with name=\"smoke_ping_2\" "
                    "and arguments={}. Reply with ONLY the exact token string it returns."
                ),
            })
            r_p2 = wait_for_reply(replies, lambda f: tokens["smoke_ping_2"] in f.get("text", ""), timeout=args.timeout)
            print(f"[smoke]   session2 reply={r_p2['text']!r}")
            if "smoke_ping_2" not in tool_calls_seen:
                raise RuntimeError("smoke_ping_2 did not reach simulated phone")
            extra_choices_2 = drain_choices()
            if extra_choices_2:
                raise RuntimeError(f"Expected 0 choices frames in session 2, got {extra_choices_2}")
            print("[smoke]   PASS: Session 2 MCP round-trip + auto-allow verified")

            # ── Check 3: /sessions + /resume <session1_id> ───────────────────────────────
            print(f"[smoke] Step 3: /sessions + /resume {session1_id}")
            post_msg({"message": "/sessions"})
            r_sess = wait_for_reply(replies, lambda f: "1. " in f.get("text", ""), timeout=args.timeout)
            print(f"[smoke]   /sessions top line={r_sess['text'].splitlines()[0]!r}")

            post_msg({"message": f"/resume {session1_id}"})
            r_res = wait_for_reply(replies, lambda f: "Resumed" in f.get("text", ""), timeout=args.timeout)
            print(f"[smoke]   /resume reply={r_res['text']!r}")

            drain_choices()
            post_msg({
                "message": (
                    "Call the hitl-channel MCP tool call_phone_tool with name=\"smoke_ping_resume\" "
                    "and arguments={}. Reply with ONLY the exact token string it returns."
                ),
            })
            r_p3 = wait_for_reply(replies, lambda f: tokens["smoke_ping_resume"] in f.get("text", ""), timeout=args.timeout)
            print(f"[smoke]   resumed session reply={r_p3['text']!r}")
            if drain_choices():
                raise RuntimeError("Expected 0 choices frames on resumed session hitl tool")
            print("[smoke]   PASS: session/resume with re-injected MCP verified")

            # ── Check 4: Non-hitl tool permission round-trip ─────────────────────────────
            print("[smoke] Step 4: Non-hitl permission round-trip (Allow via choice_response)")
            if perm_target_file.exists():
                perm_target_file.unlink()
            drain_choices()
            post_msg({
                "message": (
                    f"Run this exact shell command: printf 'SMOKE_PERM_OK\\n' > {perm_target_file} "
                    "and then reply with DONE."
                ),
            })
            perm_card = choices_frames.get(timeout=args.timeout)
            print(f"[smoke]   received permission choices card: {perm_card.get('content')!r} options={perm_card.get('choices')}")
            options = perm_card.get("choices") or []
            allow_label = next(
                (c for c in options if any(tok in str(c).lower() for tok in ("allow", "yes"))),
                options[0] if options else "Allow",
            )
            post_msg({
                "type": "choice_response",
                "content": allow_label,
                "selections": [allow_label],
            })
            r_perm = wait_for_reply(
                replies,
                lambda f: "DONE" in f.get("text", "").upper() or "SMOKE_PERM_OK" in f.get("text", ""),
                timeout=args.timeout,
            )
            print(f"[smoke]   permission turn reply={r_perm['text']!r}")
            if not perm_target_file.exists():
                raise RuntimeError(f"Expected shell command to create {perm_target_file} after Allow")
            print("[smoke]   PASS: Permission card -> choice_response Allow -> command executed")

        # ── Check 5: SIGTERM clean shutdown + pgid cleanup <= 5s ─────────────────────
        print("[smoke] Step 5: SIGTERM clean shutdown")
        descendant_pids_before, child_pgids_before = list_descendants_and_child_pgids(daemon_proc.pid)
        shutdown_deadline = time.time() + 5.0
        daemon_proc.send_signal(signal.SIGTERM)
        exit_code = daemon_proc.wait(timeout=5.0)
        if exit_code != 0:
            raise RuntimeError(f"Daemon exited with non-zero code on SIGTERM: {exit_code}")

        # Detached grandchild stdio children (e.g. mcp-shim or harness MCP children) may
        # tear down via stdin EOF a few milliseconds after the main daemon exits. Poll up
        # to the 5s shutdown budget before reporting leaked PIDs/PGIDs.
        surviving_descendants: list[int] = []
        surviving_pgid_pids: list[int] = []
        while True:
            surviving_descendants = []
            for dpid in descendant_pids_before:
                try:
                    os.kill(dpid, 0)
                    surviving_descendants.append(dpid)
                except ProcessLookupError:
                    pass
            surviving_pgid_pids = find_live_pids_in_pgids(child_pgids_before)
            if not surviving_descendants and not surviving_pgid_pids:
                break
            if time.time() >= shutdown_deadline:
                break
            time.sleep(0.05)

        if surviving_descendants:
            raise RuntimeError(f"Descendant pids still alive after SIGTERM: {surviving_descendants}")
        if surviving_pgid_pids:
            raise RuntimeError(f"Detached child process group still alive after SIGTERM: {surviving_pgid_pids}")
        print("[smoke]   PASS: Daemon and all descendant/process-group children terminated cleanly")
        print("CV6_HANDSHAKE_SMOKE_PASS" if args.handshake_only else "CV6_ACP_SMOKE_PASS")
        return 0
    finally:
        if ws is not None:
            ws.close()
        if daemon_proc.poll() is None:
            daemon_proc.terminate()
            try:
                daemon_proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                daemon_proc.kill()
        if perm_target_file.exists():
            perm_target_file.unlink()
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
