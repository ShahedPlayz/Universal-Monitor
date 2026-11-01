#!/usr/bin/env bash
# Universal Monitor - one-line installer / control TUI
#   curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | sudo bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer requires root. For a no-root install, use:" >&2
  echo "  curl -fsSL https://github.com/ShahedPlayz/Universal-Monitor/raw/HEAD/install-nonroot.sh | bash" >&2
  exit 1
fi

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

clear_screen(){ printf '\033[2J\033[H\033[3J'; }

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
  for f in /proc/device-tree/model /sys/firmware/devicetree/base/model            /sys/class/dmi/id/product_name /sys/class/dmi/id/board_name; do
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
  ui_kv "Machine" "$(machine_label)"
  ui_kv "GPU" "$(gpu_info)"
  ui_kv "RAM" "$(mem_info)"
  ui_kv "Disk /" "$(disk_info)"
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


# ── service management ───────────────────────────────────────────────────
systemd_available(){
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

user_systemd_available(){
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

write_systemd_unit(){
  local name="$1" exec_start="$2" workdir="$3"
  cat > "/etc/systemd/system/${name}.service" <<EOF
[Unit]
Description=Universal Monitor ${name}
After=network.target

[Service]
Type=simple
WorkingDirectory=${workdir}
ExecStart=${exec_start}
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
}

start_node_service(){
  local cfg="$1"
  if systemd_available; then
    write_systemd_unit "um-node" "$PYTHON_BIN $INSTALL_DIR/um-node.py run --config $cfg" "$INSTALL_DIR"
    if systemctl daemon-reload >/dev/null 2>&1 && systemctl enable --now um-node >/dev/null 2>&1; then
      ok "Node installed as a system systemd service"
      return 0
    fi
    warn "system systemd failed; trying user systemd"
  fi
  if user_systemd_available; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/um-node.service" <<EOF
[Unit]
Description=Universal Monitor um-node
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$PYTHON_BIN $INSTALL_DIR/um-node.py run --config $cfg
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now um-node >/dev/null 2>&1; then
      ok "Node installed as a user systemd service"
      return 0
    fi
    warn "user systemd failed; falling back to pm2"
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing pm2..."
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      case "$PKG_MGR" in
        apt-get) ( apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
        dnf|yum) ( pkg_install nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
        apk)     ( pkg_install nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
        brew)    ( brew install node ) & progress_wait "Installing node" $! ;;
      esac
    else
      ok "Node.js and npm are already installed"
    fi
    if command -v npm >/dev/null 2>&1; then
      ( npm install -g pm2 >/dev/null 2>&1 || true ) & progress_wait "Installing pm2" $!
    else
      warn "npm is not available; pm2 could not be installed"
    fi
  fi
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-node >/dev/null 2>&1 || true
    pm2 start "$PYTHON_BIN" --name um-node --cwd "$INSTALL_DIR" --interpreter none -- "$INSTALL_DIR/um-node.py" run --config "$cfg"
    pm2 save >/dev/null 2>&1 || true
    ok "Node installed via pm2"
  else
    ( cd "$INSTALL_DIR" && nohup "$PYTHON_BIN" "$INSTALL_DIR/um-node.py" run --config "$cfg" >/tmp/um-node.log 2>&1 & )
    ok "Node installed in background"
  fi
}

start_web_service(){
  if systemd_available; then
    cat > "/etc/systemd/system/um-web.service" <<EOF
[Unit]
Description=Universal Monitor um-web
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/website
ExecStart=$PYTHON_BIN $INSTALL_DIR/website/app.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=UM_WEB_PORT=8787

[Install]
WantedBy=multi-user.target
EOF
    if systemctl daemon-reload >/dev/null 2>&1 && systemctl enable --now um-web >/dev/null 2>&1; then
      ok "Web installed as a system systemd service"
      return 0
    fi
    warn "system systemd failed; trying user systemd"
  fi
  if user_systemd_available; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/um-web.service" <<EOF
[Unit]
Description=Universal Monitor um-web
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/website
ExecStart=$PYTHON_BIN $INSTALL_DIR/website/app.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=UM_WEB_PORT=8787

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now um-web >/dev/null 2>&1; then
      ok "Web installed as a user systemd service"
      return 0
    fi
    warn "user systemd failed; falling back to pm2"
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing pm2..."
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      case "$PKG_MGR" in
        apt-get) ( apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
        dnf|yum) ( pkg_install nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
        apk)     ( pkg_install nodejs npm ) & progress_wait "Installing nodejs+npm" $! ;;
        brew)    ( brew install node ) & progress_wait "Installing node" $! ;;
      esac
    else
      ok "Node.js and npm are already installed"
    fi
    if command -v npm >/dev/null 2>&1; then
      ( npm install -g pm2 >/dev/null 2>&1 || true ) & progress_wait "Installing pm2" $!
    else
      warn "npm is not available; pm2 could not be installed"
    fi
  fi
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete um-web >/dev/null 2>&1 || true
    pm2 start "$PYTHON_BIN" --name um-web --cwd "$INSTALL_DIR/website" --interpreter none -- app.py
    pm2 save >/dev/null 2>&1 || true
    ok "Web installed via pm2"
  else
    ( cd "$INSTALL_DIR/website" && nohup "$PYTHON_BIN" app.py >/tmp/um-web.log 2>&1 & )
    ok "Web installed in background"
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
  "$PYTHON_BIN" "$INSTALL_DIR/um-node.py" create --name "$(node_display_name)" --host 0.0.0.0 --port 0 >/tmp/um-node-create.json
  local NODE_ID; NODE_ID="$("$PYTHON_BIN" -c 'import json;print(json.load(open("/tmp/um-node-create.json"))["id"])')"
  ok "Created node config: $NODE_ID"
  local cfg; cfg="$(ls "$INSTALL_DIR"/nodes/um-*.json | head -1)"
  start_node_service "$cfg"
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
  start_web_service
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
    env_panel
    printf "  %b╭────────────────────────────────────────────────────────────╮%b\n" "$UI_BORDER" "$NC"
    printf "  %b│%b  %bUNIVERSAL MONITOR CONTROL PANEL%b\n" "$UI_BORDER" "$NC" "$UI_TEXT" "$NC"
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

main_menu
