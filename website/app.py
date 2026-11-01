#!/usr/bin/env python3
"""Universal Monitor website.

A clean SaaS-style control plane for Universal Monitor nodes.  The website
keeps global settings and themes in SQLite, stores node credentials, proxies
live metrics over Socket.IO and forwards terminal / power commands to the
selected node agent.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from flask import Flask, abort, jsonify, redirect, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.exceptions import HTTPException

VERSION = "1.0.0"
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "um.db"

log = logging.getLogger("um-web")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("UM_SECRET_KEY") or secrets.token_hex(32)
app.config["JSON_SORT_KEYS"] = False
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*", logger=False,
                    engineio_logger=False)


# --------------------------------------------------------------------------- #
# defaults
# --------------------------------------------------------------------------- #

DEFAULT_SETTINGS: dict[str, Any] = {
    "refresh_ms": 500,
    "history_points": 90,
    "temperature_unit": "C",
    "compact": False,
    "animations": True,
    "terminal_font_size": 13,
    "node_timeout_ms": 3000,
    "show_grid": True,
    "show_sparklines": True,
    "clock_24h": True,
    "terminal_max_lines": 600,
}

THEMES: list[dict[str, str]] = [
    {"id": "midnight", "name": "Midnight", "description": "Deep indigo with electric cyan accents."},
    {"id": "carbon", "name": "Carbon", "description": "Near-black graphite with warm amber."},
    {"id": "ocean", "name": "Ocean", "description": "Abyss blue with bright aqua highlights."},
    {"id": "neon", "name": "Neon", "description": "Ultraviolet glow for night owls."},
    {"id": "sunset", "name": "Sunset", "description": "Smoked plum with coral and rose."},
    {"id": "light", "name": "Daylight", "description": "Bright, calm and easy on the eyes."},
]
THEME_IDS = {t["id"] for t in THEMES}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# database
# --------------------------------------------------------------------------- #

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                address TEXT NOT NULL,
                api_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen TEXT,
                last_status TEXT NOT NULL DEFAULT 'unknown',
                last_latency_ms REAL,
                last_error TEXT
            );
            """
        )
        if conn.execute("SELECT 1 FROM kv WHERE key='settings'").fetchone() is None:
            conn.execute("INSERT INTO kv (key, value) VALUES ('settings', ?)",
                         (json.dumps(DEFAULT_SETTINGS),))
        if conn.execute("SELECT 1 FROM kv WHERE key='theme'").fetchone() is None:
            conn.execute("INSERT INTO kv (key, value) VALUES ('theme', 'midnight')")
        conn.commit()


def kv_get(key: str, default: Any = None) -> Any:
    with db() as conn:
        row = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return default


def kv_set(key: str, value: Any) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        conn.commit()


def sanitize_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        for key in DEFAULT_SETTINGS:
            if key in raw:
                settings[key] = raw[key]

    def as_int(key: str, low: int, high: int) -> None:
        try:
            settings[key] = max(low, min(high, int(settings[key])))
        except (TypeError, ValueError):
            settings[key] = DEFAULT_SETTINGS[key]

    as_int("refresh_ms", 250, 5000)
    as_int("history_points", 20, 300)
    as_int("terminal_font_size", 10, 20)
    as_int("node_timeout_ms", 1000, 15000)
    as_int("terminal_max_lines", 100, 3000)
    if settings["temperature_unit"] not in ("C", "F"):
        settings["temperature_unit"] = "C"
    for key in ("compact", "animations", "show_grid", "show_sparklines", "clock_24h"):
        settings[key] = bool(settings[key])
    return settings


def get_settings() -> dict[str, Any]:
    return sanitize_settings(kv_get("settings", DEFAULT_SETTINGS))


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(get_settings())
    if isinstance(patch, dict):
        merged.update({k: v for k, v in patch.items() if k in DEFAULT_SETTINGS})
    settings = sanitize_settings(merged)
    kv_set("settings", settings)
    return settings


def get_theme() -> str:
    theme = kv_get("theme", "midnight")
    return theme if theme in THEME_IDS else "midnight"


# --------------------------------------------------------------------------- #
# node helpers
# --------------------------------------------------------------------------- #

class NodeError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def normalize_address(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        raise ValueError("Address is required")
    value = value.rstrip("/")
    if not re.match(r"^https?://", value, re.I):
        value = "http://" + value
    parts = urlsplit(value)
    if not parts.hostname:
        raise ValueError("Address must be a host, host:port or domain")
    return value


def node_url(node: dict[str, Any], path: str) -> str:
    base = str(node["address"]).rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    return base + path


def node_request(node: dict[str, Any], path: str, *, method: str = "GET",
                 payload: dict[str, Any] | None = None,
                 timeout: float = 3.0) -> dict[str, Any]:
    headers = {"X-API-Key": str(node.get("api_key") or ""), "Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(node_url(node, path), data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read(4 * 1024 * 1024)
    except HTTPError as exc:
        detail = ""
        try:
            body = json.loads(exc.read().decode("utf-8", errors="replace"))
            detail = str(body.get("error") or "")
        except Exception:
            pass
        if exc.code == 401:
            raise NodeError("Node rejected the API key", 401) from exc
        raise NodeError(detail or f"Node returned HTTP {exc.code}", 502) from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
            raise NodeError("Node timed out", 504) from exc
        raise NodeError(f"Node unreachable: {reason}", 502) from exc
    except (TimeoutError, OSError) as exc:
        raise NodeError(f"Node unreachable: {exc}", 502) from exc
    try:
        result = json.loads(raw.decode("utf-8", errors="replace"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise NodeError("Node returned an invalid response", 502) from exc
    if not isinstance(result, dict):
        raise NodeError("Node returned an invalid response", 502)
    if result.get("ok") is False:
        raise NodeError(str(result.get("error") or "Node request failed"), 502)
    return result


def verify_node(address: str, api_key: str, timeout: float = 4.0) -> dict[str, Any]:
    node = {"address": address, "api_key": api_key}
    return node_request(node, "/api/health", timeout=timeout)


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 12:
        return key[:4] + "…"
    return key[:10] + "…" + key[-4:]


def public_node(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    node = dict(row)
    key = node.pop("api_key", "") or ""
    node["api_key"] = key
    node["api_key_masked"] = mask_key(key)
    node["has_key"] = bool(key)
    return node


def list_nodes_raw() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM nodes ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_node_raw(node_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
    return dict(row) if row else None


def new_node_id() -> str:
    while True:
        node_id = "um-" + secrets.token_hex(3)
        with db() as conn:
            exists = conn.execute("SELECT 1 FROM nodes WHERE id=?", (node_id,)).fetchone()
        if not exists:
            return node_id


def set_node_status(node_id: str, status: str, latency: float | None = None,
                    error: str | None = None) -> None:
    seen = now_iso() if status == "online" else None
    with db() as conn:
        if status == "online":
            conn.execute(
                "UPDATE nodes SET last_status=?, last_latency_ms=?, last_error=NULL, last_seen=? WHERE id=?",
                (status, round(latency, 1) if latency is not None else None, seen, node_id),
            )
        else:
            conn.execute(
                "UPDATE nodes SET last_status=?, last_latency_ms=?, last_error=? WHERE id=?",
                (status, round(latency, 1) if latency is not None else None, error, node_id),
            )
        conn.commit()


def create_node(data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name") or "").strip()
    description = str(data.get("description") or "").strip()
    address_raw = str(data.get("address") or "").strip()
    api_key = str(data.get("api_key") or "").strip()
    if not name:
        raise ValueError("Name is required")
    if not address_raw:
        raise ValueError("Address is required")
    if not api_key:
        raise ValueError("API key is required")
    if len(name) > 80:
        raise ValueError("Name must be 80 characters or less")
    if len(description) > 500:
        raise ValueError("Description must be 500 characters or less")
    address = normalize_address(address_raw)
    started = time.monotonic()
    health = verify_node(address, api_key)
    latency = (time.monotonic() - started) * 1000
    node_id = new_node_id()
    stamp = now_iso()
    with db() as conn:
        conn.execute(
            "INSERT INTO nodes (id, name, description, address, api_key, created_at, updated_at, "
            "last_seen, last_status, last_latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', ?)",
            (node_id, name, description, address, api_key, stamp, stamp, stamp, round(latency, 1)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
    result = public_node(row)
    result["health"] = health
    return result


def update_node(node_id: str, data: dict[str, Any]) -> dict[str, Any]:
    existing = get_node_raw(node_id)
    if not existing:
        raise LookupError("Node not found")
    name = str(data.get("name", existing["name"]) or "").strip()
    description = str(data.get("description", existing["description"]) or "").strip()
    address_raw = str(data.get("address", existing["address"]) or "").strip()
    api_key = str(data.get("api_key") or "").strip() or existing["api_key"]
    if not name:
        raise ValueError("Name is required")
    if len(name) > 80:
        raise ValueError("Name must be 80 characters or less")
    if len(description) > 500:
        raise ValueError("Description must be 500 characters or less")
    address = normalize_address(address_raw)
    if address != existing["address"] or api_key != existing["api_key"]:
        verify_node(address, api_key)
    with db() as conn:
        conn.execute(
            "UPDATE nodes SET name=?, description=?, address=?, api_key=?, updated_at=? WHERE id=?",
            (name, description, address, api_key, now_iso(), node_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
    return public_node(row)


# --------------------------------------------------------------------------- #
# live pollers
# --------------------------------------------------------------------------- #

POLLERS: dict[str, "NodePoller"] = {}
POLLERS_LOCK = threading.Lock()
SID_NODES: dict[str, set[str]] = {}
SID_LOCK = threading.Lock()


class NodePoller:
    def __init__(self, node_id: str) -> None:
        self.node_id = node_id
        self.sids: set[str] = set()
        self.lock = threading.Lock()
        self.thread: Any = None
        self.last: dict[str, Any] | None = None

    def add(self, sid: str) -> None:
        with self.lock:
            self.sids.add(sid)
            needs_start = self.thread is None or not self.thread.is_alive()
        if needs_start:
            self.thread = socketio.start_background_task(self._loop)

    def remove(self, sid: str) -> None:
        with self.lock:
            self.sids.discard(sid)

    def _loop(self) -> None:
        idle_since: float | None = None
        try:
            while True:
                with self.lock:
                    active = bool(self.sids)
                if not active:
                    if idle_since is None:
                        idle_since = time.monotonic()
                    if time.monotonic() - idle_since > 20:
                        with self.lock:
                            if self.sids:
                                idle_since = None
                                continue
                            self.thread = None
                        with POLLERS_LOCK:
                            if POLLERS.get(self.node_id) is self:
                                POLLERS.pop(self.node_id, None)
                        return
                    time.sleep(0.5)
                    continue

                idle_since = None
                node = get_node_raw(self.node_id)
                if not node:
                    socketio.emit("node_error", {"node_id": self.node_id,
                                                 "error": "Node was deleted", "at": now_iso()},
                                  to=f"node:{self.node_id}")
                    return

                settings = get_settings()
                interval = max(0.25, settings["refresh_ms"] / 1000.0)
                timeout = max(1.0, settings["node_timeout_ms"] / 1000.0)
                started = time.monotonic()
                try:
                    data = node_request(node, "/api/snapshot", timeout=timeout)
                    latency = (time.monotonic() - started) * 1000
                    set_node_status(self.node_id, "online", latency)
                    payload = {
                        "node_id": self.node_id,
                        "data": data,
                        "latency_ms": round(latency, 1),
                        "received_at": now_iso(),
                    }
                    self.last = payload
                    socketio.emit("snapshot", payload, to=f"node:{self.node_id}")
                except NodeError as exc:
                    set_node_status(self.node_id, "offline", error=exc.message)
                    socketio.emit("node_error", {"node_id": self.node_id,
                                                 "error": exc.message, "at": now_iso()},
                                  to=f"node:{self.node_id}")
                except Exception as exc:  # defensive
                    log.exception("poller crashed for %s", self.node_id)
                    set_node_status(self.node_id, "offline", error=str(exc))
                    socketio.emit("node_error", {"node_id": self.node_id,
                                                 "error": str(exc), "at": now_iso()},
                                  to=f"node:{self.node_id}")

                elapsed = time.monotonic() - started
                time.sleep(max(0.05, interval - elapsed))
        except Exception:
            log.exception("poller loop ended for %s", self.node_id)
        finally:
            with self.lock:
                self.thread = None


def get_poller(node_id: str) -> NodePoller:
    with POLLERS_LOCK:
        poller = POLLERS.get(node_id)
        if poller is None:
            poller = NodePoller(node_id)
            POLLERS[node_id] = poller
        return poller


# --------------------------------------------------------------------------- #
# socket events
# --------------------------------------------------------------------------- #

@socketio.on("connect")
def on_connect() -> None:
    emit("hello", {"ok": True, "version": VERSION, "at": now_iso()})


@socketio.on("subscribe_node")
def on_subscribe(data: dict[str, Any] | None) -> None:
    node_id = str((data or {}).get("node_id") or "")
    node = get_node_raw(node_id)
    if not node:
        emit("node_error", {"node_id": node_id, "error": "Node not found", "at": now_iso()})
        return
    room = f"node:{node_id}"
    join_room(room)
    with SID_LOCK:
        SID_NODES.setdefault(request.sid, set()).add(node_id)
    poller = get_poller(node_id)
    poller.add(request.sid)
    if poller.last:
        emit("snapshot", poller.last)
    emit("subscribed", {"node_id": node_id, "at": now_iso()})


@socketio.on("unsubscribe_node")
def on_unsubscribe(data: dict[str, Any] | None) -> None:
    node_id = str((data or {}).get("node_id") or "")
    leave_room(f"node:{node_id}")
    with SID_LOCK:
        SID_NODES.get(request.sid, set()).discard(node_id)
    get_poller(node_id).remove(request.sid)


@socketio.on("disconnect")
def on_disconnect() -> None:
    with SID_LOCK:
        node_ids = SID_NODES.pop(request.sid, set())
    for node_id in node_ids:
        with POLLERS_LOCK:
            poller = POLLERS.get(node_id)
        if poller:
            poller.remove(request.sid)


# --------------------------------------------------------------------------- #
# node status monitor
# --------------------------------------------------------------------------- #

def check_one(node: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        node_request(node, "/api/health", timeout=2.5)
        latency = (time.monotonic() - started) * 1000
        set_node_status(node["id"], "online", latency)
        return {"id": node["id"], "status": "online", "latency_ms": round(latency, 1),
                "last_seen": now_iso(), "last_error": None}
    except NodeError as exc:
        set_node_status(node["id"], "offline", error=exc.message)
        return {"id": node["id"], "status": "offline", "latency_ms": None,
                "last_seen": node.get("last_seen"), "last_error": exc.message}
    except Exception as exc:
        set_node_status(node["id"], "offline", error=str(exc))
        return {"id": node["id"], "status": "offline", "latency_ms": None,
                "last_seen": node.get("last_seen"), "last_error": str(exc)}


def status_loop() -> None:
    while True:
        try:
            nodes = list_nodes_raw()
            if nodes:
                statuses: list[dict[str, Any]] = []
                with ThreadPoolExecutor(max_workers=min(8, len(nodes))) as pool:
                    futures = {pool.submit(check_one, n): n for n in nodes}
                    for future in as_completed(futures):
                        try:
                            statuses.append(future.result())
                        except Exception:
                            log.exception("status check failed")
                socketio.emit("nodes_status", {"statuses": statuses, "at": now_iso()})
        except Exception:
            log.exception("status monitor failed")
        time.sleep(5.0)


# --------------------------------------------------------------------------- #
# HTTP routes
# --------------------------------------------------------------------------- #

def boot_payload() -> dict[str, Any]:
    return {
        "version": VERSION,
        "settings": get_settings(),
        "theme": get_theme(),
        "themes": THEMES,
        "defaults": DEFAULT_SETTINGS,
        "server_time": now_iso(),
    }


def render_spa():
    return render_template("index.html", boot=boot_payload(), theme=get_theme())


@app.get("/")
def root():
    return redirect("/nodes")


@app.get("/api/health")
def api_health():
    return jsonify(ok=True, service="universal-monitor", version=VERSION, time=now_iso())


@app.get("/api/meta")
def api_meta():
    return jsonify(ok=True, **boot_payload())


@app.get("/api/nodes")
def api_nodes():
    nodes = [public_node(n) for n in list_nodes_raw()]
    online = sum(1 for n in nodes if n.get("last_status") == "online")
    return jsonify(ok=True, nodes=nodes, online=online, total=len(nodes), time=now_iso())


@app.post("/api/nodes")
def api_add_node():
    data = request.get_json(silent=True) or {}
    try:
        node = create_node(data)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    socketio.emit("nodes_changed", {"action": "add", "node_id": node["id"]})
    return jsonify(ok=True, node=node), 201


@app.get("/api/nodes/<node_id>")
def api_get_node(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    return jsonify(ok=True, node=public_node(node))


@app.put("/api/nodes/<node_id>")
def api_edit_node(node_id: str):
    data = request.get_json(silent=True) or {}
    try:
        node = update_node(node_id, data)
    except LookupError:
        return jsonify(ok=False, error="Node not found"), 404
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    socketio.emit("nodes_changed", {"action": "edit", "node_id": node_id})
    return jsonify(ok=True, node=node)


@app.delete("/api/nodes/<node_id>")
def api_delete_node(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    with db() as conn:
        conn.execute("DELETE FROM nodes WHERE id=?", (node_id,))
        conn.commit()
    with POLLERS_LOCK:
        POLLERS.pop(node_id, None)
    socketio.emit("nodes_changed", {"action": "delete", "node_id": node_id})
    return jsonify(ok=True)


@app.post("/api/nodes/<node_id>/check")
def api_check_node(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    result = check_one(node)
    socketio.emit("nodes_status", {"statuses": [result], "at": now_iso()})
    return jsonify(ok=result["status"] == "online", status=result), 200


@app.get("/api/nodes/<node_id>/snapshot")
def api_node_snapshot(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    settings = get_settings()
    timeout = max(1.0, settings["node_timeout_ms"] / 1000.0)
    started = time.monotonic()
    try:
        data = node_request(node, "/api/snapshot", timeout=timeout)
        latency = (time.monotonic() - started) * 1000
        set_node_status(node_id, "online", latency)
        return jsonify(ok=True, data=data, latency_ms=round(latency, 1), received_at=now_iso())
    except NodeError as exc:
        set_node_status(node_id, "offline", error=exc.message)
        return jsonify(ok=False, error=exc.message), exc.status


@app.post("/api/nodes/<node_id>/terminal")
def api_node_terminal(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    data = request.get_json(silent=True) or {}
    command = str(data.get("command") or "")
    if not command.strip():
        return jsonify(ok=False, error="Command is required"), 400
    try:
        result = node_request(node, "/api/terminal", method="POST",
                              payload={"command": command, "timeout": 60}, timeout=65)
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    return jsonify(result)


@app.post("/api/nodes/<node_id>/pty/start")
def api_node_pty_start(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    data = request.get_json(silent=True) or {}
    command = str(data.get("command") or "btop")
    try:
        cols = int(data.get("cols") or 120)
        rows = int(data.get("rows") or 32)
    except (TypeError, ValueError):
        cols, rows = 120, 32
    try:
        result = node_request(node, "/api/pty/start", method="POST",
                              payload={"command": command, "cols": cols, "rows": rows}, timeout=10)
    except NodeError as exc:
        if exc.status == 404:
            return jsonify(ok=False, error="This node agent is too old. Run api-installer.sh on that VPS to update it."), 404
        return jsonify(ok=False, error=exc.message), exc.status
    return jsonify(result)


@app.post("/api/nodes/<node_id>/pty/input")
def api_node_pty_input(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    data = request.get_json(silent=True) or {}
    session = str(data.get("session") or "")
    if not session:
        return jsonify(ok=False, error="session is required"), 400
    payload = {"session": session}
    if data.get("data_b64"):
        payload["data_b64"] = str(data.get("data_b64"))
    else:
        payload["data"] = str(data.get("data") or "")
    try:
        result = node_request(node, "/api/pty/input", method="POST", payload=payload, timeout=10)
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    return jsonify(result)


@app.post("/api/nodes/<node_id>/pty/resize")
def api_node_pty_resize(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    data = request.get_json(silent=True) or {}
    session = str(data.get("session") or "")
    if not session:
        return jsonify(ok=False, error="session is required"), 400
    try:
        cols = int(data.get("cols") or 0)
        rows = int(data.get("rows") or 0)
    except (TypeError, ValueError):
        cols, rows = 0, 0
    try:
        result = node_request(node, "/api/pty/resize", method="POST",
                              payload={"session": session, "cols": cols, "rows": rows}, timeout=10)
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    return jsonify(result)


@app.post("/api/nodes/<node_id>/pty/stop")
def api_node_pty_stop(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    data = request.get_json(silent=True) or {}
    session = str(data.get("session") or "")
    if not session:
        return jsonify(ok=False, error="session is required"), 400
    try:
        result = node_request(node, "/api/pty/stop", method="POST",
                              payload={"session": session}, timeout=10)
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    return jsonify(result)


@app.get("/api/nodes/<node_id>/pty/stream")
def api_node_pty_stream(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    session = str(request.args.get("session") or "")
    if not session:
        return jsonify(ok=False, error="session is required"), 400
    import urllib.request as _ur
    from flask import Response, stream_with_context
    url = node_url(node, f"/api/pty/stream?session={session}")
    req = _ur.Request(url, headers={"X-API-Key": str(node.get("api_key") or ""), "Accept": "text/event-stream"})

    def generate():
        try:
            with _ur.urlopen(req, timeout=300) as resp:
                for line in resp:
                    yield line
        except Exception as exc:
            yield f"event: error\ndata: {exc}\n\n".encode("utf-8")

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.post("/api/nodes/<node_id>/control")
def api_node_control(node_id: str):
    node = get_node_raw(node_id)
    if not node:
        return jsonify(ok=False, error="Node not found"), 404
    data = request.get_json(silent=True) or {}
    action = str(data.get("action") or "").lower()
    confirm = str(data.get("confirm") or "")
    if action not in ("reboot", "shutdown"):
        return jsonify(ok=False, error="Invalid action"), 400
    expected = "REBOOT" if action == "reboot" else "SHUTDOWN"
    if confirm != expected:
        return jsonify(ok=False, error=f"Confirmation token must be {expected}"), 400
    try:
        result = node_request(node, "/api/control", method="POST",
                              payload={"action": action, "confirm": confirm}, timeout=8)
    except NodeError as exc:
        return jsonify(ok=False, error=exc.message), exc.status
    socketio.emit("nodes_changed", {"action": "power", "node_id": node_id})
    return jsonify(result)


@app.get("/api/settings")
def api_get_settings():
    return jsonify(ok=True, settings=get_settings(), defaults=DEFAULT_SETTINGS)


@app.put("/api/settings")
def api_put_settings():
    data = request.get_json(silent=True) or {}
    settings = save_settings(data)
    socketio.emit("settings_changed", settings)
    return jsonify(ok=True, settings=settings)


@app.get("/api/theme")
def api_get_theme():
    return jsonify(ok=True, theme=get_theme(), themes=THEMES)


@app.put("/api/theme")
def api_put_theme():
    data = request.get_json(silent=True) or {}
    theme = str(data.get("theme") or "")
    if theme not in THEME_IDS:
        return jsonify(ok=False, error="Unknown theme"), 400
    kv_set("theme", theme)
    socketio.emit("theme_changed", theme)
    return jsonify(ok=True, theme=theme)


@app.route("/<path:path>")
def spa(path: str):
    if path.startswith("api/") or path.startswith("socket.io"):
        abort(404)
    return render_spa()


@app.errorhandler(404)
def handle_404(exc):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="Not found"), 404
    return redirect("/nodes")


@app.errorhandler(Exception)
def handle_exception(exc):
    if isinstance(exc, HTTPException):
        return exc
    log.exception("unhandled error on %s", request.path)
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="Internal server error"), 500
    return render_spa(), 500


# --------------------------------------------------------------------------- #
# startup
# --------------------------------------------------------------------------- #

init_db()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    socketio.start_background_task(status_loop)
    port = int(os.environ.get("UM_WEB_PORT", "8787"))
    log.info("Universal Monitor website listening on 0.0.0.0:%s", port)
    socketio.run(app, host="0.0.0.0", port=port, debug=False, use_reloader=False,
                 allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
