#!/usr/bin/env bash
# Universal Monitor - no-root installer / control TUI
#   curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install-nonroot.sh | bash
#
# This installer never uses sudo, apt, dnf, yum, apk, brew or pacman.
# Everything is installed under your home directory:
#   ~/.universal-monitor
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "This installer is for non-root users. Use install.sh as root instead." >&2
  exit 1
fi

# Ensure interactive input works even when piped.
if [ ! -t 0 ]; then
  if [ -r /dev/tty ]; then exec 0</dev/tty; else echo "No TTY available"; exit 1; fi
fi

REPO_URL="https://github.com/ShahedPlayz/Universal-Monitor"
RAW_URL="https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main"
ARCHIVE_URL="https://github.com/ShahedPlayz/Universal-Monitor/archive/refs/heads/main.tar.gz"

# ── UI palette ───────────────────────────────────────────────────────────
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
read_line(){
  local __var="$1" __prompt="${2:-}"
  local __in=""
  read -r -p "$__prompt" __in || true
  printf -v "$__var" '%s' "$__in"
}
clear_screen(){ printf '\033[2J\033[H\033[3J'; }
pause(){ read_line _ "  Press Enter to continue..."; }

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
  printf "  %bUniversal Monitor%b %b·%b %bNO-ROOT INSTALLER%b\n\n" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC" "$UI_MUTED" "$NC"
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

# ── environment ──────────────────────────────────────────────────────────
INSTALL_DIR="${UNIVERSAL_MONITOR_DIR:-$HOME/.universal-monitor}"
LOG_DIR="$INSTALL_DIR/logs"
RUN_DIR="$INSTALL_DIR/run"
NODES_DIR="$INSTALL_DIR/nodes"
VENV_DIR="$INSTALL_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
PY_RUN=""
PYTHONPATH_EXTRA=""
WEB_PORT="${UM_WEB_PORT:-8787}"

OS_NAME="$(uname -s 2>/dev/null || echo Unknown)"
case "$OS_NAME" in
  Linux) OS_KIND="linux" ;;
  Darwin) OS_KIND="macos" ;;
  CYGWIN*|MINGW*|MSYS*) OS_KIND="windows" ;;
  *) OS_KIND="unknown" ;;
esac

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then PYTHON_BIN="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then PYTHON_BIN="$(command -v python)"
else
  err "Python 3 is required but was not found in PATH."
  exit 1
fi

if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  err "Python 3.8 or newer is required."
  exit 1
fi
PY_RUN="$PYTHON_BIN"

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  err "curl or wget is required."
  exit 1
fi

# ── detection ────────────────────────────────────────────────────────────
human_bytes(){
  local bytes="${1:-0}"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$bytes" 2>/dev/null || echo "${bytes} B"
  else
    awk -v b="$bytes" 'BEGIN{
      split("B KB MB GB TB PB",u," "); i=1;
      while (b>=1024 && i<6) { b/=1024; i++ }
      printf (b>=100 ? "%.0f %s" : b>=10 ? "%.1f %s" : "%.2f %s"), b, u[i]
    }'
  fi
}

device_model(){
  local f v
  for f in /proc/device-tree/model /sys/firmware/devicetree/base/model \
           /sys/class/dmi/id/product_name /sys/class/dmi/id/board_name; do
    [ -r "$f" ] || continue
    v="$(tr -d '\000' < "$f" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
      ""|"to be filled by o.e.m."|"system product name"|"default string") continue ;;
    esac
    printf '%s' "$v"; return 0
  done
  printf ''
}

device_vendor(){
  local f v
  for f in /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/board_vendor; do
    [ -r "$f" ] || continue
    v="$(tr -d '\000' < "$f" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  printf ''
}

machine_type(){
  local text
  text="$(printf '%s %s %s %s' "$(device_model)" "$(device_vendor)" "$(uname -m)" "$(uname -n)" | tr '[:upper:]' '[:lower:]')"
  if [ -f /.dockerenv ] || grep -qaE 'docker|lxc|kubepods' /proc/1/cgroup 2>/dev/null; then
    echo "Container"; return
  fi
  if grep -qiE 'kvm|qemu|vmware|virtualbox|hyper-v|xen|bochs|virtual machine|openstack|digitalocean|linode' <<<"$text"; then
    echo "Virtual Machine"; return
  fi
  if grep -qiE 'x96|tx3|tx5|tx6|tx9|tx20|tx 20|h96|h616|h618|s905|s912|s922|amlogic|allwinner|sun50i|tanix|beelink|minix|magicsee|ugoos|tv box|android box' <<<"$text"; then
    echo "TV Box"; return
  fi
  if grep -qiE 'raspberry pi|orange pi|banana pi|rock pi|nanopi|odroid|radxa|khadas|pine64|tinker board|single board' <<<"$text"; then
    echo "Single Board Computer"; return
  fi
  if grep -qiE 'laptop|notebook|thinkpad|ideapad' <<<"$text"; then
    echo "Laptop"; return
  fi
  if grep -qiE 'server|poweredge|proliant|rack' <<<"$text"; then
    echo "Server"; return
  fi
  if grep -qiE 'aarch64|armv7|armv6|arm64' <<<"$text"; then
    echo "ARM Device"; return
  fi
  echo "Desktop"
}

machine_label(){
  local model type
  model="$(device_model)"; type="$(machine_type)"
  [ -n "$model" ] || model="$(hostname)"
  printf '%s (%s)' "$model" "$type"
}

node_display_name(){
  local model
  model="$(device_model)"
  case "$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]')" in
    ""|*"to be filled"*|*"default string"*|*"system product"*) model="$(hostname)" ;;
  esac
  printf '%s' "$model"
}

cpu_label(){
  local label part impl
  label="$(awk -F: '/model name|^Hardware|^Processor/{gsub(/^[ \t]+|[ \t]+$/,"",$2); if ($2!=""){print $2; exit}}' /proc/cpuinfo 2>/dev/null || true)"
  if [ -z "$label" ]; then
    impl="$(awk -F: '/CPU implementer/{gsub(/[ \t]/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)"
    part="$(awk -F: '/CPU part/{gsub(/[ \t]/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)"
    case "$impl:$part" in
      0x41:0xd03) label="ARM Cortex-A53" ;;
      0x41:0xd04) label="ARM Cortex-A35" ;;
      0x41:0xd05) label="ARM Cortex-A55" ;;
      0x41:0xd07) label="ARM Cortex-A57" ;;
      0x41:0xd08) label="ARM Cortex-A72" ;;
      0x41:0xd09) label="ARM Cortex-A73" ;;
      0x41:0xd0b) label="ARM Cortex-A76" ;;
      0x41:0xd0d) label="ARM Cortex-A77" ;;
      0x41:0xd41) label="ARM Cortex-A78" ;;
      0x41:0xd44) label="ARM Cortex-X1" ;;
      0x41:0xd46) label="ARM Cortex-A510" ;;
      0x41:0xd47) label="ARM Cortex-A710" ;;
      0x41:0xd48) label="ARM Cortex-X2" ;;
      0x41:0xd4d) label="ARM Cortex-A715" ;;
      0x41:0xd4e) label="ARM Cortex-X3" ;;
      0x41:0xd80) label="ARM Cortex-A520" ;;
      0x41:0xd81) label="ARM Cortex-A720" ;;
      0x41:0xd82) label="ARM Cortex-X4" ;;
    esac
  fi
  [ -n "$label" ] || label="$(uname -m) CPU"
  printf '%s' "$label"
}

mem_info(){
  local total avail used
  total="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  avail="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  [ "${avail:-0}" -gt 0 ] || avail="$(awk '/^MemFree:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  used=$(( total > avail ? total - avail : 0 ))
  printf '%s / %s · %s available' "$(human_bytes $((used * 1024)))" "$(human_bytes $((total * 1024)))" "$(human_bytes $((avail * 1024)))"
}

disk_info(){
  local total_k used_k avail_k total used avail
  read -r total_k used_k avail_k < <(df -Pk / 2>/dev/null | awk 'NR==2{print $2, $3, $4}')
  total=$(( ${total_k:-0} * 1024 ))
  used=$(( ${used_k:-0} * 1024 ))
  avail=$(( ${avail_k:-0} * 1024 ))
  printf '%s / %s · %s available' "$(human_bytes "$used")" "$(human_bytes "$total")" "$(human_bytes "$avail")"
}

gpu_info(){
  if [ "$OS_KIND" != "linux" ]; then
    if [ "$OS_KIND" = "macos" ]; then
      system_profiler SPDisplaysDataType 2>/dev/null | grep -i "chipset\|model" | head -1 | sed 's/^ *//' || echo "GPU does not exist"
    else
      echo "GPU does not exist"
    fi
    return
  fi
  if command -v nvidia-smi >/dev/null 2>&1; then
    local nv
    nv="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | tr -d '\r')"
    [ -n "$nv" ] && { echo "NVIDIA $nv"; return; }
  fi
  local name="" soc=""
  if [ -r /proc/device-tree/compatible ]; then
    soc="$(tr '\000' ' ' < /proc/device-tree/compatible 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  fi
  case "$soc" in
    *sun50i-h616*|*sun50i-h618*|*sun8i-h616*) name="ARM Mali-G31/G52" ;;
    *sun50i-h6*) name="ARM Mali-T720" ;;
    *sun50i-h5*|*sun8i-h3*) name="ARM Mali-450/400" ;;
    *meson-g12a*) name="ARM Mali-G31" ;;
    *meson-g12b*) name="ARM Mali-G52" ;;
    *meson-gxm*) name="ARM Mali-T820" ;;
    *rk3588*) name="ARM Mali-G610" ;;
    *rk3566*|*rk3568*) name="ARM Mali-G52" ;;
    *rk3399*) name="ARM Mali-T860" ;;
    *rk3328*) name="ARM Mali-450" ;;
    *bcm2711*) name="Broadcom VideoCore VI" ;;
    *bcm283*) name="Broadcom VideoCore IV" ;;
    *tegra*) name="NVIDIA Tegra" ;;
    *qcom*|*msm*) name="Qualcomm Adreno" ;;
  esac
  if [ -z "$name" ] && command -v lspci >/dev/null 2>&1; then
    name="$(lspci 2>/dev/null | grep -iE 'vga compatible|3d controller|display controller' | head -1 | sed -E 's/^[0-9a-fA-F:.]+[[:space:]]+(VGA compatible controller|3D controller|Display controller):[[:space:]]*//')"
  fi
  if [ -z "$name" ] && command -v rocm-smi >/dev/null 2>&1; then
    name="$(rocm-smi --showproductname 2>/dev/null | grep -i 'card series' | head -1 | sed 's/.*: //')"
  fi
  if [ -z "$name" ] && [ -d /sys/class/drm ]; then
    local d drv
    for d in /sys/class/drm/card*/device/driver; do
      [ -e "$d" ] || continue
      drv="$(basename "$(readlink -f "$d")")"
      name="GPU ($drv)"; break
    done
  fi
  [ -n "$name" ] || name="GPU does not exist"
  printf '%s' "$name"
}

env_panel(){
  ui_section "DETECTED MACHINE"
  ui_kv "Machine" "$(machine_label)"
  ui_kv "Architecture" "$(uname -m)"
  ui_kv "CPU" "$(cpu_label)"
  ui_kv "GPU" "$(gpu_info)"
  ui_kv "RAM" "$(mem_info)"
  ui_kv "Disk /" "$(disk_info)"
  ui_kv "Install dir" "$INSTALL_DIR"
}

# ── download / python environment ────────────────────────────────────────
download_archive(){
  local out="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$ARCHIVE_URL" -o "$out"
  else
    wget -qO "$out" "$ARCHIVE_URL"
  fi
}

download_project(){
  mkdir -p "$INSTALL_DIR"
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/um-nonroot.XXXXXX")"
  info "Downloading Universal Monitor into $INSTALL_DIR ..."
  if ! download_archive "$tmp/um.tar.gz"; then
    rm -rf "$tmp"; return 1
  fi
  if ! tar -xzf "$tmp/um.tar.gz" -C "$tmp"; then
    err "Extract failed"; rm -rf "$tmp"; return 1
  fi
  local src; src="$(find "$tmp" -maxdepth 1 -type d -name 'Universal-Monitor-*' | head -1)"
  if [ -z "$src" ]; then
    err "Archive layout unexpected"; rm -rf "$tmp"; return 1
  fi
  cp -a "$src/." "$INSTALL_DIR/"
  rm -rf "$tmp"
  ok "Downloaded"
}

detect_env(){
  PY_RUN="$PYTHON_BIN"
  PYTHONPATH_EXTRA=""
  if [ -x "$VENV_PY" ] && "$VENV_PY" -c 'import sys' 2>/dev/null; then
    PY_RUN="$VENV_PY"
  elif [ -d "$INSTALL_DIR/.pydeps" ]; then
    PYTHONPATH_EXTRA="$INSTALL_DIR/.pydeps"
  fi
}

ensure_env(){
  PY_RUN="$PYTHON_BIN"
  PYTHONPATH_EXTRA=""
  if [ -x "$VENV_PY" ] && "$VENV_PY" -c 'import sys' 2>/dev/null; then
    PY_RUN="$VENV_PY"
    return 0
  fi
  mkdir -p "$INSTALL_DIR"
  info "Creating user Python environment..."
  if "$PYTHON_BIN" -m venv "$VENV_DIR" >/dev/null 2>&1; then
    PY_RUN="$VENV_PY"
    ok "Created venv at $VENV_DIR"
    return 0
  fi
  warn "Python venv is unavailable; falling back to $INSTALL_DIR/.pydeps"
  mkdir -p "$INSTALL_DIR/.pydeps"
  PYTHONPATH_EXTRA="$INSTALL_DIR/.pydeps"
  PY_RUN="$PYTHON_BIN"
  if ! "$PY_RUN" -m pip --version >/dev/null 2>&1; then
    fail "pip is not available. Install pip or python3-venv (this may require admin)."
    return 1
  fi
}

py_exec(){
  if [ -n "$PYTHONPATH_EXTRA" ]; then
    PYTHONPATH="$PYTHONPATH_EXTRA${PYTHONPATH:+:$PYTHONPATH}" "$PY_RUN" "$@"
  else
    "$PY_RUN" "$@"
  fi
}

install_web_deps(){
  info "Installing Python packages into user environment..."
  if [ -n "$PYTHONPATH_EXTRA" ]; then
    "$PY_RUN" -m pip install --disable-pip-version-check --upgrade \
      --target "$PYTHONPATH_EXTRA" flask flask-socketio python-socketio
  else
    "$PY_RUN" -m pip install --disable-pip-version-check --upgrade pip
    "$PY_RUN" -m pip install --disable-pip-version-check -r "$INSTALL_DIR/requirements.txt"
  fi
}

# ── process helpers ──────────────────────────────────────────────────────
pid_alive(){ local p="${1:-}"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
read_pid(){ [ -f "$1" ] && cat "$1" 2>/dev/null || true; }

stop_pidfile(){
  local file="$1" name="$2" pid i
  pid="$(read_pid "$file")"
  if pid_alive "$pid"; then
    info "Stopping $name (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    for ((i=0; i<20; i++)); do
      pid_alive "$pid" || break
      sleep 0.2
    done
    if pid_alive "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$file"
}

find_node_config(){
  local f
  for f in "$NODES_DIR"/um-*.json; do
    [ -f "$f" ] && { printf '%s' "$f"; return 0; }
  done
  return 1
}

http_ok(){
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" >/dev/null 2>&1
  else
    wget -qO- "$url" >/dev/null 2>&1
  fi
}

node_http_ok(){
  local url="$1" key="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "X-API-Key: $key" "$url" >/dev/null 2>&1
  else
    wget -qO- --header="X-API-Key: $key" "$url" >/dev/null 2>&1
  fi
}


user_systemd_available(){
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

start_node(){
  local cfg; cfg="$(find_node_config)" || { warn "No node config. Install Node first."; return 1; }
  stop_pidfile "$RUN_DIR/um-node.pid" "node"
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  info "Starting node..."
  if user_systemd_available; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/um-node.service" <<EOF
[Unit]
Description=Universal Monitor um-node
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$PY_RUN $INSTALL_DIR/um-node.py run --config $cfg
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
EOF
    if [ -n "$PYTHONPATH_EXTRA" ]; then
      sed -i "s#^ExecStart=.*#ExecStart=env PYTHONPATH=$PYTHONPATH_EXTRA $PY_RUN $INSTALL_DIR/um-node.py run --config $cfg#" "$HOME/.config/systemd/user/um-node.service"
    fi
    if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now um-node >/dev/null 2>&1; then
      ok "Node started as a user systemd service"
      return 0
    fi
    warn "user systemd failed; falling back to pm2/nohup"
  fi
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-node >/dev/null 2>&1 || true
    if [ -n "$PYTHONPATH_EXTRA" ]; then
      env PYTHONPATH="$PYTHONPATH_EXTRA" pm2 start "$PY_RUN" --name um-node --cwd "$INSTALL_DIR" --interpreter none -- "$INSTALL_DIR/um-node.py" run --config "$cfg" >/dev/null 2>&1
    else
      pm2 start "$PY_RUN" --name um-node --cwd "$INSTALL_DIR" --interpreter none -- "$INSTALL_DIR/um-node.py" run --config "$cfg" >/dev/null 2>&1
    fi
    pm2 save >/dev/null 2>&1 || true
    ok "Node started via pm2"
    return 0
  fi
  if [ -n "$PYTHONPATH_EXTRA" ]; then
    nohup env PYTHONPATH="$PYTHONPATH_EXTRA" "$PY_RUN" "$INSTALL_DIR/um-node.py" run --config "$cfg" \
      > "$LOG_DIR/um-node.log" 2>&1 &
  else
    nohup "$PY_RUN" "$INSTALL_DIR/um-node.py" run --config "$cfg" \
      > "$LOG_DIR/um-node.log" 2>&1 &
  fi
  echo $! > "$RUN_DIR/um-node.pid"
  sleep 1
  if pid_alive "$(read_pid "$RUN_DIR/um-node.pid")"; then
    ok "Node started (PID $(read_pid "$RUN_DIR/um-node.pid"))"
  else
    fail "Node failed to start. See $LOG_DIR/um-node.log"
    return 1
  fi
}

stop_node(){ stop_pidfile "$RUN_DIR/um-node.pid" "node"; ok "Node stopped"; }

start_web(){
  [ -f "$INSTALL_DIR/website/app.py" ] || { warn "Web is not installed."; return 1; }
  stop_pidfile "$RUN_DIR/um-web.pid" "web"
  mkdir -p "$LOG_DIR" "$RUN_DIR" "$INSTALL_DIR/website/data"
  info "Starting web on port $WEB_PORT..."
  if user_systemd_available; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/um-web.service" <<EOF
[Unit]
Description=Universal Monitor um-web
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/website
ExecStart=$PY_RUN $INSTALL_DIR/website/app.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=UM_WEB_PORT=$WEB_PORT

[Install]
WantedBy=default.target
EOF
    if [ -n "$PYTHONPATH_EXTRA" ]; then
      sed -i "s#^ExecStart=.*#ExecStart=env PYTHONPATH=$PYTHONPATH_EXTRA $PY_RUN $INSTALL_DIR/website/app.py#" "$HOME/.config/systemd/user/um-web.service"
    fi
    if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now um-web >/dev/null 2>&1; then
      ok "Web started as a user systemd service"
      return 0
    fi
    warn "user systemd failed; falling back to pm2/nohup"
  fi
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-web >/dev/null 2>&1 || true
    if [ -n "$PYTHONPATH_EXTRA" ]; then
      ( cd "$INSTALL_DIR/website" && env PYTHONPATH="$PYTHONPATH_EXTRA" UM_WEB_PORT="$WEB_PORT"           pm2 start "$PY_RUN" --name um-web --cwd "$INSTALL_DIR/website" --interpreter none -- app.py >/dev/null 2>&1 )
    else
      ( cd "$INSTALL_DIR/website" && env UM_WEB_PORT="$WEB_PORT"           pm2 start "$PY_RUN" --name um-web --cwd "$INSTALL_DIR/website" --interpreter none -- app.py >/dev/null 2>&1 )
    fi
    pm2 save >/dev/null 2>&1 || true
    ok "Web started via pm2"
    return 0
  fi
  if [ -n "$PYTHONPATH_EXTRA" ]; then
    ( cd "$INSTALL_DIR/website" && nohup env PYTHONPATH="$PYTHONPATH_EXTRA" UM_WEB_PORT="$WEB_PORT" \
        "$PY_RUN" app.py > "$LOG_DIR/um-web.log" 2>&1 & echo $! > "$RUN_DIR/um-web.pid" )
  else
    ( cd "$INSTALL_DIR/website" && nohup env UM_WEB_PORT="$WEB_PORT" \
        "$PY_RUN" app.py > "$LOG_DIR/um-web.log" 2>&1 & echo $! > "$RUN_DIR/um-web.pid" )
  fi
  sleep 2
  if pid_alive "$(read_pid "$RUN_DIR/um-web.pid")"; then
    ok "Web started (PID $(read_pid "$RUN_DIR/um-web.pid"))"
  else
    fail "Web failed to start. See $LOG_DIR/um-web.log"
    return 1
  fi
}

stop_web(){ stop_pidfile "$RUN_DIR/um-web.pid" "web"; ok "Web stopped"; }

# ── status ───────────────────────────────────────────────────────────────
node_status(){
  local cfg; cfg="$(find_node_config)" || { warn "No node config found."; return 0; }
  ui_section "NODE STATUS"
  ui_kv "Config" "$cfg"
  py_exec - "$cfg" <<'PY' >&2
import json, sys
c=json.load(open(sys.argv[1]))
for k, label in (("id", "ID"), ("name", "Name"), ("host", "Host"), ("port", "Port"), ("api_key", "API key")):
    print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % (label, c.get(k)))
print("  \033[38;5;244m▌\033[0m \033[38;5;244m%-14s\033[0m \033[1;97m%s\033[0m" % ("Address", f"{c.get('host')}:{c.get('port')}".replace("0.0.0.0","127.0.0.1")))
PY
  local port key
  port="$(py_exec - "$cfg" <<'PY'
import json,sys;print(json.load(open(sys.argv[1])).get("port"))
PY
)"
  key="$(py_exec - "$cfg" <<'PY'
import json,sys;print(json.load(open(sys.argv[1])).get("api_key"))
PY
)"
  if node_http_ok "http://127.0.0.1:$port/api/health" "$key"; then
    ok "Node agent is online on port $port"
  else
    warn "Node agent is not responding on port $port"
  fi
  ui_kv "Machine" "$(machine_label)"
  ui_kv "GPU" "$(gpu_info)"
  ui_kv "RAM" "$(mem_info)"
  ui_kv "Disk /" "$(disk_info)"
}

web_status(){
  ui_section "WEB STATUS"
  local pid; pid="$(read_pid "$RUN_DIR/um-web.pid")"
  if pid_alive "$pid"; then
    ok "Web process is running (PID $pid) on port $WEB_PORT"
  else
    warn "Web process is not running"
  fi
  if http_ok "http://127.0.0.1:$WEB_PORT/"; then
    ok "Web control plane is online at http://127.0.0.1:$WEB_PORT"
  else
    warn "Web HTTP is not responding on port $WEB_PORT"
  fi
}

# ── install / uninstall ──────────────────────────────────────────────────
install_node(){
  if [ "$OS_KIND" != "linux" ]; then
    warn "Node agent requires Linux (uses /proc). Skipping on $OS_KIND."
    return 0
  fi
  ui_section "INSTALL NODE"
  if find_node_config >/dev/null 2>&1; then
    warn "Existing node config found."
    local ans=""; read_line ans "Proceed with fresh install? [y/N]: "
    case "$ans" in y|Y) ;; *) warn "Aborted."; return 0;; esac
  fi
  stop_node >/dev/null 2>&1 || true
  detect_env
  ( download_project ) & progress_wait "Downloading project" $!
  [ -f "$INSTALL_DIR/um-node.py" ] || { fail "um-node.py not found after download"; return 1; }
  mkdir -p "$NODES_DIR"
  rm -f "$NODES_DIR"/um-*.json "$NODES_DIR"/*.runtime.json 2>/dev/null || true
  local out="$RUN_DIR/create.json"
  mkdir -p "$RUN_DIR"
  if ! py_exec "$INSTALL_DIR/um-node.py" create --name "$(node_display_name)" --host 0.0.0.0 --port 0 > "$out"; then
    fail "Failed to create node config"
    return 1
  fi
  ok "Created node config: $(py_exec -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$out")"
  start_node
  node_status
}

uninstall_node(){
  ui_section "UNINSTALL NODE"
  stop_node >/dev/null 2>&1 || true
  rm -f "$NODES_DIR"/um-*.json "$NODES_DIR"/*.runtime.json 2>/dev/null || true
  rm -f "$RUN_DIR/um-node.pid"
  ok "Node config and process removed"
}

install_web(){
  ui_section "INSTALL WEB"
  local reinstall=1
  if [ -d "$INSTALL_DIR/website" ]; then
    warn "Existing web files found. Data in website/data is kept."
    local ans=""; read_line ans "Reinstall web files? [y/N]: "
    case "$ans" in y|Y) reinstall=1 ;; *) reinstall=0 ;; esac
  fi
  stop_web >/dev/null 2>&1 || true
  ensure_env || return 1
  if [ "$reinstall" -eq 1 ]; then
    ( download_project ) & progress_wait "Downloading project" $!
    [ -f "$INSTALL_DIR/website/app.py" ] || { fail "website/app.py not found after download"; return 1; }
  fi
  ( install_web_deps ) & progress_wait "Installing Python packages" $!
  mkdir -p "$INSTALL_DIR/website/data"
  start_web
  web_status
}

uninstall_web(){
  ui_section "UNINSTALL WEB"
  stop_web >/dev/null 2>&1 || true
  local ans=""; read_line ans "Remove website files and data too? [y/N]: "
  case "$ans" in
    y|Y) rm -rf "$INSTALL_DIR/website"; ok "Web files removed" ;;
    *)   ok "Web process stopped; files kept" ;;
  esac
}

# ── menus ────────────────────────────────────────────────────────────────
node_menu(){
  while true; do
    clear_screen; banner
    printf "  %b╭────────────────────────────────────────────────────────────╮%b\n" "$UI_BORDER" "$NC"
    printf "  %b│%b  %bNODE CONTROL%b\n" "$UI_BORDER" "$NC" "$UI_TEXT" "$NC"
    printf "  %b╰────────────────────────────────────────────────────────────╯%b\n\n" "$UI_BORDER" "$NC"
    printf "  %b[1]%b  %bInstall Node%b\n"    "$GREEN" "$NC" "$UI_TEXT" "$NC"
    printf "  %b[2]%b  %bStart Node%b\n"      "$GREEN" "$NC" "$UI_TEXT" "$NC"
    printf "  %b[3]%b  %bStop Node%b\n"       "$RED"   "$NC" "$UI_TEXT" "$NC"
    printf "  %b[4]%b  %bRestart Node%b\n"    "$CYAN"  "$NC" "$UI_TEXT" "$NC"
    printf "  %b[5]%b  %bUninstall Node%b\n"  "$RED"   "$NC" "$UI_TEXT" "$NC"
    printf "  %b[6]%b  %bBack%b\n\n"          "$UI_MUTED" "$NC" "$UI_TEXT" "$NC"
    local c=""; read_line c "  ❯ Select option: "
    case "$c" in
      1) install_node; pause ;;
      2) start_node; pause ;;
      3) stop_node; pause ;;
      4) stop_node >/dev/null 2>&1 || true; start_node; pause ;;
      5) uninstall_node; pause ;;
      6) return ;;
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
    printf "  %b[1]%b  %bInstall Web%b\n"     "$GREEN" "$NC" "$UI_TEXT" "$NC"
    printf "  %b[2]%b  %bStart Web%b\n"       "$GREEN" "$NC" "$UI_TEXT" "$NC"
    printf "  %b[3]%b  %bStop Web%b\n"        "$RED"   "$NC" "$UI_TEXT" "$NC"
    printf "  %b[4]%b  %bRestart Web%b\n"     "$CYAN"  "$NC" "$UI_TEXT" "$NC"
    printf "  %b[5]%b  %bUninstall Web%b\n"   "$RED"   "$NC" "$UI_TEXT" "$NC"
    printf "  %b[6]%b  %bBack%b\n\n"          "$UI_MUTED" "$NC" "$UI_TEXT" "$NC"
    local c=""; read_line c "  ❯ Select option: "
    case "$c" in
      1) install_web; pause ;;
      2) start_web; pause ;;
      3) stop_web; pause ;;
      4) stop_web >/dev/null 2>&1 || true; start_web; pause ;;
      5) uninstall_web; pause ;;
      6) return ;;
      *) warn "Invalid option"; sleep 1 ;;
    esac
  done
}

main_menu(){
  while true; do
    clear_screen; banner
    env_panel
    printf "  %b╭────────────────────────────────────────────────────────────╮%b\n" "$UI_BORDER" "$NC"
    printf "  %b│%b  %bUNIVERSAL MONITOR · NO ROOT%b\n" "$UI_BORDER" "$NC" "$UI_TEXT" "$NC"
    printf "  %b╰────────────────────────────────────────────────────────────╯%b\n\n" "$UI_BORDER" "$NC"
    printf "  %b[1]%b  %bNode%b           %bManage node agent%b\n"   "$GREEN"   "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[2]%b  %bWeb%b            %bManage web control plane%b\n" "$CYAN"  "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[3]%b  %bStatus Web%b     %bShow web service status%b\n" "$UI_ACCENT" "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[4]%b  %bStatus Node%b    %bShow node agent status%b\n"  "$UI_ACCENT" "$NC" "$UI_TEXT" "$NC" "$UI_MUTED" "$NC"
    printf "  %b[0]%b  %bExit%b\n\n" "$UI_MUTED" "$NC" "$UI_TEXT" "$NC"
    local choice=""; read_line choice "  ❯ Select option [0-4]: "
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

detect_env
main_menu
