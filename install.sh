#!/usr/bin/env bash
# Universal Monitor - one-line installer / control TUI
#   curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | sudo bash
set -euo pipefail

# Ensure interactive input works even when piped
if [ ! -t 0 ]; then
  if [ -r /dev/tty ]; then exec 0</dev/tty; else echo "No TTY available"; exit 1; fi
fi

REPO_URL="https://github.com/ShahedPlayz/Universal-Monitor"
RAW_URL="https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main"
ARCHIVE_URL="https://github.com/ShahedPlayz/Universal-Monitor/archive/refs/heads/main.tar.gz"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
MAGENTA='\033[0;35m'; CYAN='\033[0;36m'; WHITE='\033[1;37m'; BOLD='\033[1m'; RESET='\033[0m'

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
  echo -e "${RESET}${MAGENTA}${BOLD}   Universal Monitor - Installer / TUI${RESET}"
  echo -e "${BLUE}   SGM (c) - do not modify${RESET}\n"
}

ok() { echo -e "${GREEN}[ OK ]${RESET} $*"; }
info() { echo -e "${CYAN}[ .. ]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; }

banner

if [ "$(id -u)" -eq 0 ]; then
  ROOT_MODE=1
  DEFAULT_DIR="/opt/universal-monitor"
else
  ROOT_MODE=0
  DEFAULT_DIR="$HOME/.universal-monitor"
fi
INSTALL_DIR="${UNIVERSAL_MONITOR_DIR:-$DEFAULT_DIR}"

# detect environment
OS_NAME="$(uname -s 2>/dev/null || echo Unknown)"
case "$OS_NAME" in
  Linux) OS_KIND="linux" ;;
  Darwin) OS_KIND="macos" ;;
  CYGWIN*|MINGW*|MSYS*) OS_KIND="windows" ;;
  *) OS_KIND="unknown" ;;
esac

PKG_MGR=""
for c in apt-get dnf yum apk brew pacman; do
  if command -v "$c" >/dev/null 2>&1; then PKG_MGR="$c"; break; fi
done

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then PYTHON_BIN="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then PYTHON_BIN="$(command -v python)"
fi

echo -e "${WHITE}Environment:${RESET} $OS_NAME ($OS_KIND)"
echo -e "${WHITE}Package mgr:${RESET} ${PKG_MGR:-none}"
echo -e "${WHITE}Python:${RESET} ${PYTHON_BIN:-none}"
echo -e "${WHITE}Install dir:${RESET} $INSTALL_DIR"
echo

# download project if needed
if [ ! -f "${INSTALL_DIR}/um-node.py" ]; then
  info "Downloading Universal Monitor into $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$ARCHIVE_URL" -o /tmp/um-monitor.tar.gz
  elif command -v wget >/dev/null 2>&1; then
    wget -qO /tmp/um-monitor.tar.gz "$ARCHIVE_URL"
  else
    fail "curl or wget is required"
  fi
  tar -xzf /tmp/um-monitor.tar.gz -C "$INSTALL_DIR" --strip-components=1
  rm -f /tmp/um-monitor.tar.gz
  ok "Downloaded"
fi

cd "$INSTALL_DIR"

gpu_info() {
  if [ "$OS_KIND" = "linux" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then
      nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1
    elif [ -d /dev/dri ]; then
      ls /dev/dri 2>/dev/null | tr '\n' ' '
    else
      echo "none detected"
    fi
  elif [ "$OS_KIND" = "macos" ]; then
    system_profiler SPDisplaysDataType 2>/dev/null | grep -i "chipset\|model" | head -1 || echo "unknown"
  elif [ "$OS_KIND" = "windows" ]; then
    echo "detect via Device Manager / WMI"
  else
    echo "unknown"
  fi
}

node_status() {
  local cfg=""
  for c in "$INSTALL_DIR"/nodes/um-*.json; do [ -f "$c" ] && cfg="$c" && break; done
  if [ -z "$cfg" ]; then
    warn "No node config found."
    return
  fi
  echo -e "${WHITE}Config:${RESET} $cfg"
  "$PYTHON_BIN" - "$cfg" <<'PY'
import json, sys
c=json.load(open(sys.argv[1]))
print("ID      :", c.get("id"))
print("Name    :", c.get("name"))
print("Host    :", c.get("host"))
print("Port    :", c.get("port"))
print("API key :", c.get("api_key"))
print("Address :", f"{c.get('host')}:{c.get('port')}".replace("0.0.0.0","127.0.0.1"))
PY
  local port key
  port="$("$PYTHON_BIN" - "$cfg" <<'PY'
import json,sys;print(json.load(open(sys.argv[1])).get("port"))
PY
)"
  key="$("$PYTHON_BIN" - "$cfg" <<'PY'
import json,sys;print(json.load(open(sys.argv[1])).get("api_key"))
PY
)"
  if curl -s -H "X-API-Key: $key" "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    ok "Node agent is online on port $port"
  else
    warn "Node agent is not responding on port $port"
  fi
  echo "GPU: $(gpu_info)"
}

web_status() {
  if command -v pm2 >/dev/null 2>&1 && pm2 describe um-web >/dev/null 2>&1; then
    pm2 describe um-web | grep -E "status|pid|uptime|script path" | head
    if curl -s http://127.0.0.1:8787/ >/dev/null 2>&1; then
      ok "Web control plane is online on port 8787"
    else
      warn "Web process exists but HTTP is not responding"
    fi
  else
    warn "Web is not installed/running"
  fi
}

install_node() {
  if [ "$OS_KIND" != "linux" ]; then
    warn "Node agent requires Linux (uses /proc). Skipping on $OS_KIND."
    return
  fi
  # check existing
  if ls "$INSTALL_DIR"/nodes/um-*.json >/dev/null 2>&1 || [ -f "$INSTALL_DIR/um-node.py" ]; then
    echo -e "${YELLOW}Existing node files/config found.${RESET}"
    read -r -p "Proceed with fresh install? [y/N]: " ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { warn "Aborted."; return; }
  fi
  info "Nuclear cleanup of old node..."
  pm2 delete um-node >/dev/null 2>&1 || true
  rm -f "$INSTALL_DIR"/nodes/um-*.json "$INSTALL_DIR"/nodes/*.runtime.json
  rm -f "$INSTALL_DIR/um-node.py"
  # install btop
  if ! command -v btop >/dev/null 2>&1; then
    info "Installing btop..."
    case "$PKG_MGR" in
      apt-get) apt-get update -qq && apt-get install -y -qq btop ;;
      dnf) dnf install -y btop ;;
      yum) yum install -y btop ;;
      apk) apk add --no-cache btop ;;
      brew) brew install btop ;;
      *) warn "Could not install btop automatically" ;;
    esac
  fi
  if [ ! -f "$INSTALL_DIR/um-node.py" ]; then
    fail "um-node.py not found after download"
  fi
  mkdir -p "$INSTALL_DIR/nodes"
  rm -f "$INSTALL_DIR"/nodes/um-*.json "$INSTALL_DIR"/nodes/*.runtime.json
  "$PYTHON_BIN" "$INSTALL_DIR/um-node.py" create --name "$(hostname)" --host 0.0.0.0 --port 0 >/tmp/um-node-create.json
  NODE_ID="$("$PYTHON_BIN" -c 'import json; print(json.load(open("/tmp/um-node-create.json"))["id"])')"
  ok "Created node config: $NODE_ID"
  # pm2
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing pm2..."
    if [ -n "$PKG_MGR" ]; then
      case "$PKG_MGR" in
        apt-get) apt-get update -qq && apt-get install -y -qq nodejs npm ;;
        dnf) dnf install -y nodejs npm ;;
        yum) yum install -y nodejs npm ;;
        apk) apk add --no-cache nodejs npm ;;
        brew) brew install node ;;
      esac
    fi
    npm install -g pm2 || true
  fi
  local cfg
  cfg="$(ls "$INSTALL_DIR"/nodes/um-*.json | head -1)"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-node >/dev/null 2>&1 || true
    pm2 start "$PYTHON_BIN" --name um-node --cwd "$INSTALL_DIR" --interpreter none -- "$INSTALL_DIR/um-node.py" run --config "$cfg"
    pm2 save >/dev/null 2>&1 || true
  else
    nohup "$PYTHON_BIN" "$INSTALL_DIR/um-node.py" run --config "$cfg" >/tmp/um-node.log 2>&1 &
  fi
  ok "Node installed"
  node_status
}

install_web() {
  if ls "$INSTALL_DIR/website" >/dev/null 2>&1; then
    echo -e "${YELLOW}Existing web files found.${RESET}"
    read -r -p "Proceed with fresh install? [y/N]: " ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { warn "Aborted."; return; }
  fi
  info "Installing web dependencies..."
  "$PYTHON_BIN" -m pip install --quiet --upgrade flask flask-socketio python-socketio 2>/dev/null || true
  mkdir -p "$INSTALL_DIR/website/data"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-web >/dev/null 2>&1 || true
    pm2 start "$PYTHON_BIN" --name um-web --cwd "$INSTALL_DIR/website" --interpreter none -- app.py
    pm2 save >/dev/null 2>&1 || true
  else
    cd "$INSTALL_DIR/website"
    nohup "$PYTHON_BIN" app.py >/tmp/um-web.log 2>&1 &
  fi
  ok "Web installed"
  web_status
}

while true; do
  banner
  echo "  [1] Install Node"
  echo "  [2] Install Web"
  echo "  [3] Status Web"
  echo "  [4] Status Node"
  echo "  [5] Exit"
  echo
  read -r -p "Select option: " choice
  case "$choice" in
    1) install_node ;;
    2) install_web ;;
    3) web_status ;;
    4) node_status ;;
    5) echo "Goodbye."; exit 0 ;;
    *) warn "Invalid option" ;;
  esac
  echo
  read -r -p "Press Enter to continue..." _
done
