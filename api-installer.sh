#!/usr/bin/env bash
# api-installer.sh - Universal Monitor node agent installer / repair tool
set -euo pipefail

if [ -z "${ROOT:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for candidate in "$SCRIPT_DIR" "/root/Own-Programs/Universal-Monitor" "/opt/universal-monitor" "/opt/Universal-Monitor" "/srv/universal-monitor" "/usr/local/universal-monitor" "$(pwd)"; do
    if [ -f "$candidate/um-node.py" ]; then ROOT="$candidate"; break; fi
  done
fi
if [ -z "${ROOT:-}" ]; then
  mkdir -p /opt/universal-monitor
  ROOT="/opt/universal-monitor"
fi
DEFAULT_PORT="${PORT:-34767}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BOLD='\033[1m'
RESET='\033[0m'

banner() {
  echo -e "${CYAN}${BOLD}"
  cat <<'BANNER'
  ███████╗ ██████╗ ███╗   ███╗
  ██╔════╝██╔════╝ ████╗ ████║
  ███████╗██║  ███╗██╔████╔██║
  ╚════██║██║   ██║██║╚██╔╝██║
  ███████║╚██████╔╝██║ ╚═╝ ██║
  ╚══════╝ ╚═════╝ ╚═╝     ╚═╝
BANNER
  echo -e "${RESET}${MAGENTA}${BOLD}   Universal Monitor Node Agent Installer${RESET}"
  echo -e "${BLUE}   stable port · stable API key · no rotation${RESET}\n"
}

ok()   { echo -e "${GREEN}[ OK ]${RESET} $*"; }
info() { echo -e "${CYAN}[ .. ]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; exit 1; }

banner

if [ "$(id -u)" -ne 0 ]; then
  fail "Please run this installer as root."
fi

info "Installing latest embedded agent into $ROOT ..."
mkdir -p "$ROOT"
base64 -d > "$ROOT/um-node.py" <<'UMNODE_B64'
__EMBEDDED__
UMNODE_B64
  chmod +x "$ROOT/um-node.py"
  ok "Embedded um-node.py installed"

PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ] && [ -x "$ROOT/.venv/bin/python" ]; then
  PYTHON="$ROOT/.venv/bin/python"
fi
if [ -z "$PYTHON" ]; then
  PYTHON="$(command -v python3 || true)"
fi
[ -n "$PYTHON" ] && [ -x "$PYTHON" ] || fail "python3 is required"
PY_VERSION="$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
ok "Python $PY_VERSION found: $PYTHON"

mkdir -p "$ROOT/nodes"
ok "Node config directory ready: $ROOT/nodes"

# Ensure btop is available for the BTOP++ page
if ! command -v btop >/dev/null 2>&1; then
  info "btop not found; attempting installation..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq btop
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y btop
  elif command -v yum >/dev/null 2>&1; then
    yum install -y btop
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache btop
  else
    warn "Could not install btop automatically. Install it manually for BTOP++."
  fi
fi
if command -v btop >/dev/null 2>&1; then
  ok "btop is available: $(command -v btop)"
else
  warn "btop is not installed; BTOP++ page will not work until it is."
fi

port_available() {
  "$PYTHON" - "$1" <<'PY'
import socket, sys
port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("", port))
    print("free")
except OSError:
    print("busy")
finally:
    sock.close()
PY
}

info "Nuclear cleanup: removing old configs and stale agent process..."
pm2 delete um-node >/dev/null 2>&1 || true
rm -f "$ROOT"/nodes/um-*.json "$ROOT"/nodes/*.runtime.json
CONFIG=""

if [ -z "$CONFIG" ]; then
  info "No existing node config found. Creating a new stable config..."
  if [ "$(port_available "$DEFAULT_PORT")" = "free" ]; then
    PORT="$DEFAULT_PORT"
  else
    warn "Port $DEFAULT_PORT is busy; selecting a free port once."
    PORT="$("$PYTHON" -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
  fi
  info "Using fixed port: $PORT"
  "$PYTHON" "$ROOT/um-node.py" create --name "$(hostname)" --host 0.0.0.0 --port "$PORT" >/tmp/um-node-create.json
  NODE_ID="$("$PYTHON" -c 'import json; print(json.load(open("/tmp/um-node-create.json"))["id"])')"
  CONFIG="$ROOT/nodes/${NODE_ID}.json"
  ok "Created config: $CONFIG"
else
  ok "Existing config found: $CONFIG"
fi

# Normalize / repair config: ensure port is a real fixed number.
INFO="$("$PYTHON" - "$CONFIG" <<'PY'
import json, socket, pathlib, sys
p = pathlib.Path(sys.argv[1])
cfg = json.loads(p.read_text())
if not cfg.get("port"):
    s = socket.socket(); s.bind(("", 0)); cfg["port"] = s.getsockname()[1]; s.close()
    p.write_text(json.dumps(cfg, indent=2) + "\n")
print(f'{cfg["id"]}|{cfg["name"]}|{cfg["host"]}|{cfg["port"]}|{cfg["api_key"]}')
PY
)"
IFS='|' read -r NODE_ID NODE_NAME NODE_HOST NODE_PORT API_KEY <<<"$INFO"

[ -n "$NODE_ID" ] && [ -n "$API_KEY" ] || fail "Could not read node credentials from $CONFIG"
ok "Config validated: $NODE_ID on port $NODE_PORT"

if [ "$NODE_HOST" = "0.0.0.0" ] || [ -z "$NODE_HOST" ]; then
  DISPLAY_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$DISPLAY_HOST" ] || DISPLAY_HOST="127.0.0.1"
else
  DISPLAY_HOST="$NODE_HOST"
fi

# pm2 setup
if ! command -v pm2 >/dev/null 2>&1; then
  info "pm2 not found; attempting installation..."
  if ! command -v npm >/dev/null 2>&1; then
    info "npm not found; attempting to install Node.js/npm..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y nodejs npm
    elif command -v yum >/dev/null 2>&1; then
      yum install -y nodejs npm
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache nodejs npm
    else
      fail "No supported package manager found. Install Node.js/npm/pm2 manually."
    fi
  fi
  command -v npm >/dev/null 2>&1 || fail "npm is required to install pm2"
  npm install -g pm2
fi
ok "pm2 is available"

info "Restarting node agent without changing its port..."
if pm2 describe um-node >/dev/null 2>&1; then
  pm2 restart um-node
else
  pm2 start "$PYTHON" --name um-node --cwd "$ROOT" --interpreter none -- "$ROOT/um-node.py" run --config "$CONFIG"
fi
pm2 save >/dev/null 2>&1 || true
ok "pm2 process saved"

# Health check
info "Waiting for agent health check..."
HEALTH_OK="no"
for _ in $(seq 1 30); do
  if "$PYTHON" - "$DISPLAY_HOST" "$NODE_PORT" "$API_KEY" <<'PY' >/dev/null 2>&1
import json, sys, urllib.request
host, port, key = sys.argv[1], sys.argv[2], sys.argv[3]
req = urllib.request.Request(f"http://{host}:{port}/api/health", headers={"X-API-Key": key})
with urllib.request.urlopen(req, timeout=3) as resp:
    data = json.load(resp)
    if not data.get("ok", True):
        raise SystemExit(1)
PY
  then
    HEALTH_OK="yes"
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" != "yes" ]; then
  warn "Health check did not pass. Recent pm2 logs:"
  pm2 logs um-node --lines 40 --nostream || true
  fail "Agent is not responding on $DISPLAY_HOST:$NODE_PORT"
fi
ok "Agent is healthy"

echo
echo -e "${GREEN}${BOLD}============================================================${RESET}"
echo -e "${WHITE}${BOLD}  SGM NODE READY${RESET}"
echo -e "${GREEN}${BOLD}============================================================${RESET}"
echo -e "${CYAN}Node ID      :${RESET} ${BOLD}${NODE_ID}${RESET}"
echo -e "${CYAN}Name         :${RESET} ${NODE_NAME}"
echo -e "${CYAN}Host         :${RESET} ${NODE_HOST}"
echo -e "${CYAN}Port         :${RESET} ${BOLD}${NODE_PORT}${RESET}  (fixed - will not rotate)"
echo -e "${CYAN}Address      :${RESET} ${DISPLAY_HOST}:${NODE_PORT}"
echo -e "${CYAN}API Key      :${RESET} ${BOLD}${MAGENTA}${API_KEY}${RESET}"
echo -e "${CYAN}Config       :${RESET} ${CONFIG}"
echo -e "${CYAN}Health URL   :${RESET} http://${DISPLAY_HOST}:${NODE_PORT}/api/health"
echo -e "${GREEN}${BOLD}============================================================${RESET}"
echo
echo -e "${YELLOW}Add this node in the website with:${RESET}"
echo -e "  Address : ${BOLD}${DISPLAY_HOST}:${NODE_PORT}${RESET}"
echo -e "  API key : ${BOLD}${API_KEY}${RESET}"
echo
echo -e "${BLUE}Useful commands:${RESET}"
echo -e "  pm2 restart um-node        # restarts on the same port"
echo -e "  pm2 logs um-node           # view agent logs"
echo -e "  cat ${CONFIG}              # view saved credentials"
echo
