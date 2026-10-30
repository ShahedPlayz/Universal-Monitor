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

# ── UI palette (SGM style) ───────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'
MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
UI_BORDER='\033[38;5;39m'; UI_ACCENT='\033[38;5;45m'; UI_ACCENT2='\033[38;5;213m'
UI_MUTED='\033[38;5;244m'; UI_TEXT='\033[1;97m'; WHITE="$UI_TEXT"

log(){  echo -e "${GREEN}[$(date +'%H:%M:%S')] $1${NC}" >&2; }
warn(){ echo -e "${YELLOW}[$(date +'%H:%M:%S')] $1${NC}" >&2; }
err(){  echo -e "${RED}[$(date +'%H:%M:%S')] $1${NC}" >&2; }
info(){ echo -e "${CYAN}[$(date +'%H:%M:%S')] $1${NC}" >&2; }
ok(){   log "$1"; }
fail(){ err "$1"; }

# ── UI helpers ───────────────────────────────────────────────────────────
ui_cols(){
  local c="${COLUMNS:-}"
  if [ -z "$c" ] && [ -r /dev/tty ]; then c="$(tput cols </dev/tty 2>/dev/null || true)"; fi
  [ -z "$c" ] && c="$(tput cols 2>/dev/null || true)"
  case "$c" in ''|*[!0-9]*) c=80;; esac
  [ "$c" -gt 100 ] && c=100
  [ "$c" -lt 46 ]  && c=46
  printf '%s' "$c"
}
ui_repeat(){
  local n="$1" ch="${2:-─}" s
  [ "$n" -lt 0 ] && n=0
  s="$(printf '%*s' "$n" '')"
  printf '%s' "${s// /$ch}"
}
ui_trim(){
  local val="$1" max="$2"
  if [ "${#val}" -le "$max" ]; then printf '%s' "$val"; else printf '%s…' "${val:0:$((max-1))}"; fi
}
ui_section(){
  local label="$1" w inner avail l r
  w="$(ui_cols)"; inner=$((w-2)); avail=$((inner-${#label}-2))
  [ "$avail" -lt 4 ] && avail=4
  l=$((avail/2)); r=$((avail-l))
  printf '\n  %b%s%b %s %b%s%b\n' "$UI_BORDER" "$(ui_repeat "$l")" "$UI_TEXT" "$label" "$UI_BORDER" "$(ui_repeat "$r")" "$NC" >&2
}
ui_kv(){
  local k="$1" v="$2" w max
  w="$(ui_cols)"; max=$((w-20)); [ "$max" -lt 10 ] && max=10
  printf '  %b▌%b %b%-14s%b %b%s%b\n' "$UI_ACCENT" "$NC" "$UI_MUTED" "$k" "$NC" "$UI_TEXT" "$(ui_trim "$v" "$max")" "$NC" >&2
}
ui_rule(){ printf '  %b─────────────────────────────────────────────────────────────%b\n' "$UI_BORDER" "$NC" >&2; }
read_line(){ # safe read even under pipefail
  local __var="$1" __prompt="${2:-}"
  local __in=""
  read -r -p "$__prompt" __in || true
  printf -v "$__var" '%s' "$__in"
}

clear_screen(){ printf '\033[2J\033[H'; }

banner(){
  clear_screen
  local c=(51 45 39 33 27 21) i
  local logo=(
'███████╗ ██████╗ ███╗   ███╗'
'██╔════╝██╔════╝ ████╗ ████║'
'███████╗██║  ███╗██╔████╔██║'
'╚════██║██║   ██║██║╚██╔╝██║'
'███████║╚██████╔╝██║ ╚═╝ ██║'
'╚══════╝ ╚═════╝ ╚═╝     ╚═╝'
  )
  echo
  for i in "${!logo[@]}"; do
    printf "  \033[38;5;%sm%s\033[0m\n" "${c[$i]}" "${logo[$i]}"
  done
  printf "  %bUniversal Monitor%b %b·%b %bINSTALLER & CONTROL PANEL%b\n\n" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC" "$UI_MUTED" "$NC"
}

spin(){
  local pid="$1" msg="$2" chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r%b%s%b %s" "$CYAN" "${chars:$i:1}" "$NC" "$msg" >&2
    i=$(( (i+1)%${#chars} )); sleep 0.08
  done
  printf "\r%b✔%b %s\n" "$GREEN" "$NC" "$msg" >&2
}

progress_wait(){
  local label="$1" pid="$2" pct=0 i=0 rc=0 chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  while kill -0 "$pid" 2>/dev/null; do
    [ "$pct" -lt 99 ] && pct=$((pct+1))
    printf "\r%b%s%b %s [%3d%%]" "$CYAN" "${chars:$i:1}" "$NC" "$label" "$pct" >&2
    i=$(( (i+1)%${#chars} )); sleep 0.25
  done
  wait "$pid" 2>/dev/null || rc=$?
  printf "\r%b✔%b %s [100%%]\033[K\n" "$GREEN" "$NC" "$label" >&2
  return $rc
}

# ── environment detection ────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  ROOT_MODE=1
  DEFAULT_DIR="/opt/universal-monitor"
else
  ROOT_MODE=0
  DEFAULT_DIR="$HOME/.universal-monitor"
fi
INSTALL_DIR="${UNIVERSAL_MONITOR_DIR:-$DEFAULT_DIR}"

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
else
  err "Python 3 is required but was not found in PATH."
  exit 1
fi

pkg_install(){
  case "$PKG_MGR" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf)     dnf install -y "$@" ;;
    yum)     yum install -y "$@" ;;
    apk)     apk add --no-cache "$@" ;;
    brew)    brew install "$@" ;;
    pacman)  pacman -Sy --noconfirm "$@" ;;
    *)       return 1 ;;
  esac
}

# ── download / extract ───────────────────────────────────────────────────
download_archive(){
  local tmp="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$ARCHIVE_URL" -o "$tmp"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$ARCHIVE_URL"
  else
    err "curl or wget is required"
    return 1
  fi
}

download_project(){
  mkdir -p "$INSTALL_DIR"
  local tmp; tmp="$(mktemp -d)"
  info "Downloading Universal Monitor into $INSTALL_DIR ..."
  download_archive "$tmp/um.tar.gz" || { rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/um.tar.gz" -C "$tmp" || { err "Extract failed"; rm -rf "$tmp"; return 1; }
  local src; src="$(find "$tmp" -maxdepth 1 -type d -name 'Universal-Monitor-*' | head -1)"
  [ -n "$src" ] || { err "Archive layout unexpected"; rm -rf "$tmp"; return 1; }
  cp -a "$src/." "$INSTALL_DIR/"
  rm -rf "$tmp"
  ok "Downloaded"
}

# ── status helpers ───────────────────────────────────────────────────────
gpu_info(){
  if [ "$OS_KIND" = "linux" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then
      nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1 | tr -d '\n'
    elif [ -d /dev/dri ]; then
      ls /dev/dri 2>/dev/null | tr '\n' ' ' | sed 's/ $//'
    else
      echo "none detected"
    fi
  elif [ "$OS_KIND" = "macos" ]; then
    system_profiler SPDisplaysDataType 2>/dev/null | grep -i "chipset\|model" | head -1 | sed 's/^ *//' || echo "unknown"
  elif [ "$OS_KIND" = "windows" ]; then
    echo "detect via Device Manager / WMI"
  else
    echo "unknown"
  fi
}

node_status(){
  local cfg=""
  for c in "$INSTALL_DIR"/nodes/um-*.json; do [ -f "$c" ] && cfg="$c" && break; done
  if [ -z "$cfg" ]; then warn "No node config found."; return 0; fi
  ui_section "NODE STATUS"
  ui_kv "Config" "$cfg"
  "$PYTHON_BIN" - "$cfg" <<'PY' >&2
import json, sys
c=json.load(open(sys.argv[1]))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("ID", c.get("id")))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("Name", c.get("name")))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("Host", c.get("host")))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("Port", c.get("port")))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("API key", c.get("api_key")))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("Address", f"{c.get('host')}:{c.get('port')}".replace("0.0.0.0","127.0.0.1")))
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
  ui_kv "GPU" "$(gpu_info)"
}

web_status(){
  ui_section "WEB STATUS"
  if command -v pm2 >/dev/null 2>&1 && pm2 describe um-web >/dev/null 2>&1; then
    pm2 describe um-web 2>/dev/null | grep -E "status|pid|uptime|script path" | head >&2 || true
    if curl -s http://127.0.0.1:8787/ >/dev/null 2>&1; then
      ok "Web control plane is online on port 8787"
    else
      warn "Web process exists but HTTP is not responding"
    fi
  else
    warn "Web is not installed/running"
  fi
}

# ── node install / uninstall ─────────────────────────────────────────────
install_node(){
  if [ "$OS_KIND" != "linux" ]; then
    warn "Node agent requires Linux (uses /proc). Skipping on $OS_KIND."
    return 0
  fi
  ui_section "INSTALL NODE"
  if ls "$INSTALL_DIR"/nodes/um-*.json >/dev/null 2>&1 || [ -f "$INSTALL_DIR/um-node.py" ]; then
    warn "Existing node files/config found."
    local ans=""; read_line ans "Proceed with fresh install? [y/N]: "
    case "$ans" in y|Y) ;; *) warn "Aborted."; return 0;; esac
  fi
  info "Nuclear cleanup of old node..."
  pm2 delete um-node >/dev/null 2>&1 || true
  rm -f "$INSTALL_DIR"/nodes/um-*.json "$INSTALL_DIR"/nodes/*.runtime.json 2>/dev/null || true
  rm -f "$INSTALL_DIR/um-node.py"
  ( download_project ) & progress_wait "Downloading project" $!
  if [ ! -f "$INSTALL_DIR/um-node.py" ]; then
    fail "um-node.py not found after download"
    return 1
  fi
  # btop
  if ! command -v btop >/dev/null 2>&1; then
    info "Installing btop..."
    ( pkg_install btop >/dev/null 2>&1 || true ) & progress_wait "Installing btop" $!
  fi
  mkdir -p "$INSTALL_DIR/nodes"
  rm -f "$INSTALL_DIR"/nodes/um-*.json "$INSTALL_DIR"/nodes/*.runtime.json 2>/dev/null || true
  "$PYTHON_BIN" "$INSTALL_DIR/um-node.py" create --name "$(hostname)" --host 0.0.0.0 --port 0 >/tmp/um-node-create.json
  local NODE_ID; NODE_ID="$("$PYTHON_BIN" -c 'import json;print(json.load(open("/tmp/um-node-create.json"))["id"])')"
  ok "Created node config: $NODE_ID"
  # pm2 / node
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing pm2..."
    case "$PKG_MGR" in
      apt-get) ( apt-get update -qq && apt-get install -y -qq nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
      dnf|yum) ( pkg_install nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
      apk)     ( pkg_install nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
      brew)    ( brew install node ) & progress_wait "Installing node" $! ;;
    esac
    ( npm install -g pm2 >/dev/null 2>&1 || true ) & progress_wait "Installing pm2" $!
  fi
  local cfg; cfg="$(ls "$INSTALL_DIR"/nodes/um-*.json | head -1)"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-node >/dev/null 2>&1 || true
    pm2 start "$PYTHON_BIN" --name um-node --cwd "$INSTALL_DIR" --interpreter none -- "$INSTALL_DIR/um-node.py" run --config "$cfg"
    pm2 save >/dev/null 2>&1 || true
  else
    ( cd "$INSTALL_DIR" && nohup "$PYTHON_BIN" "$INSTALL_DIR/um-node.py" run --config "$cfg" >/tmp/um-node.log 2>&1 & )
  fi
  ok "Node installed"
  node_status
}

uninstall_node(){
  ui_section "UNINSTALL NODE"
  pm2 delete um-node >/dev/null 2>&1 || true
  rm -f "$INSTALL_DIR"/nodes/um-*.json "$INSTALL_DIR"/nodes/*.runtime.json 2>/dev/null || true
  ok "Node uninstalled"
}

# ── web install / uninstall ──────────────────────────────────────────────
install_web(){
  ui_section "INSTALL WEB"
  if ls "$INSTALL_DIR/website" >/dev/null 2>&1; then
    warn "Existing web files found."
    local ans=""; read_line ans "Proceed with fresh install? [y/N]: "
    case "$ans" in y|Y) ;; *) warn "Aborted."; return 0;; esac
  fi
  ( download_project ) & progress_wait "Downloading project" $!
  info "Installing web dependencies..."
  ( "$PYTHON_BIN" -m pip install --quiet --upgrade flask flask-socketio python-socketio 2>/dev/null || true ) \
    & progress_wait "Installing Python packages" $!
  mkdir -p "$INSTALL_DIR/website/data"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-web >/dev/null 2>&1 || true
    pm2 start "$PYTHON_BIN" --name um-web --cwd "$INSTALL_DIR/website" --interpreter none -- app.py
    pm2 save >/dev/null 2>&1 || true
  else
    ( cd "$INSTALL_DIR/website" && nohup "$PYTHON_BIN" app.py >/tmp/um-web.log 2>&1 & )
  fi
  ok "Web installed"
  web_status
}

uninstall_web(){
  ui_section "UNINSTALL WEB"
  pm2 delete um-web >/dev/null 2>&1 || true
  ok "Web uninstalled"
}

# ── menus ────────────────────────────────────────────────────────────────
pause(){ read_line _ "  Press Enter to continue..."; }

node_menu(){
  while true; do
    clear_screen; banner
    printf "  %b╭────────────────────────────────────────────────────────────╮%b\n" "$UI_BORDER" "$NC"
    printf "  %b│%b  %bNODE CONTROL%b\n" "$UI_BORDER" "$NC" "$UI_TEXT" "$NC"
    printf "  %b╰────────────────────────────────────────────────────────────╯%b\n\n" "$UI_BORDER" "$NC"
    printf "  %b[1]%b  %bInstall Node%b\n"   "$GREEN" "$NC" "$UI_TEXT" "$NC"
    printf "  %b[2]%b  %bUninstall Node%b\n" "$RED"   "$NC" "$UI_TEXT" "$NC"
    printf "  %b[3]%b  %bBack%b\n\n"         "$UI_MUTED" "$NC" "$UI_TEXT" "$NC"
    local c=""; read_line c "  ❯ Select option: "
    case "$c" in
      1) install_node; pause ;;
      2) uninstall_node; pause ;;
      3) return ;;
      *) warn "Invalid option"; sleep 1 ;;
    esac
  done
}

web_menu(){
  while true; do
    clear_screen; banner
    printf "  %b╭────────────────────────────────────────────────────────────╮%b\n" "$UI_BORDER" "$NC"
    printf "  %b│%b  %bWEB CONTROL%b\n" "$UI_BORDER" "$NC" "$UI_TEXT" "$NC"
    printf "  %b╰────────────────────────────────────────────────────────────╯%b\n\n" "$UI_BORDER" "$NC"
    printf "  %b[1]%b  %bInstall Web%b\n"   "$GREEN" "$NC" "$UI_TEXT" "$NC"
    printf "  %b[2]%b  %bUninstall Web%b\n" "$RED"   "$NC" "$UI_TEXT" "$NC"
    printf "  %b[3]%b  %bBack%b\n\n"        "$UI_MUTED" "$NC" "$UI_TEXT" "$NC"
    local c=""; read_line c "  ❯ Select option: "
    case "$c" in
      1) install_web; pause ;;
      2) uninstall_web; pause ;;
      3) return ;;
      *) warn "Invalid option"; sleep 1 ;;
    esac
  done
}

main_menu(){
  while true; do
    clear_screen; banner
    printf "  %b╭────────────────────────────────────────────────────────────╮%b\n" "$UI_BORDER" "$NC"
    printf "  %b│%b  %bUNIVERSAL MONITOR CONTROL PANEL%b\n" "$UI_BORDER" "$NC" "$UI_TEXT" "$NC"
    printf "  %b╰────────────────────────────────────────────────────────────╯%b\n\n" "$UI_BORDER" "$NC"
    printf "  %b[1]%b  %bNode%b           %bManage node agent%b\n"   "$GREEN"   "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[2]%b  %bWeb%b            %bManage web control plane%b\n" "$CYAN"  "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[3]%b  %bStatus Web%b     %bShow web service status%b\n" "$UI_ACCENT" "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[4]%b  %bStatus Node%b    %bShow node agent status%b\n"  "$UI_ACCENT" "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[0]%b  %bExit%b\n\n" "$UI_MUTED" "$NC" "$UI_TEXT" "$NC"
    local choice=""; read_line choice "  ❯ Select option %b[0-4]%b: "
    case "$choice" in
      1) node_menu ;;
      2) web_menu ;;
      3) clear_screen; banner; web_status;  pause ;;
      4) clear_screen; banner; node_status; pause ;;
      0|q|Q) log "Goodbye."; exit 0 ;;
      *) warn "Invalid option"; sleep 1 ;;
    esac
  done
}

main_menu
