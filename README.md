# Universal Monitor

Universal Monitor is a lightweight control plane for Linux nodes. It exposes live CPU, memory, disk, network, GPU and thermal metrics, an interactive web terminal, BTOP++ process monitoring, power controls and node management through a modern web dashboard.

## Features

- Real-time node metrics over WebSocket
- Interactive terminal and BTOP++ PTY
- Node management with API keys
- Machine detection: desktop, laptop, server, VM, container, ARM device, SBC, TV box
- GPU detection: ARM Mali/Panfrost, NVIDIA, AMD/ATI, Intel, Qualcomm, Broadcom, VideoCore
- Memory and disk views show used, total and available capacity
- `GPU does not exist` fallback when no GPU is detected
- Themes, settings and node health checks
- Cross-platform installer TUI with detected machine panel
- Stable ports and API keys across restarts

## Root installation

Run this on a supported Linux VPS as root:

```bash
sudo bash -c 'tmp=$(mktemp /tmp/.sgm-installer.XXXXXX.sh); trap "rm -f \"$tmp\"" EXIT INT TERM; curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | tr -d "\r" > "$tmp"; bash "$tmp"'
```

The root installer downloads the project, installs system dependencies, creates a stable node config and starts the services with pm2. It includes a TUI menu for installing the node, installing the web control plane, and checking status. The main menu also shows the detected machine type, CPU, GPU, RAM and root disk usage.

## No-root installation

Use the dedicated no-root installer when you do not have sudo access. It never uses `sudo`, `apt`, `dnf`, `yum`, `apk`, `brew` or `pacman`, and installs everything under `~/.universal-monitor`:

```bash
bash -c 'tmp=$(mktemp /tmp/.sgm-nonroot.XXXXXX.sh); trap "rm -f \"$tmp\"" EXIT INT TERM; curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install-nonroot.sh | tr -d "\r" > "$tmp"; bash "$tmp"'
```

The no-root installer creates a user Python virtual environment, installs the web dependencies there, and manages the node and web processes with PID files. It does not install `btop` automatically; install it yourself if you want the BTOP page.

## License

This project is proprietary software owned by SGM. You may not modify, redistribute, sublicense or reverse engineer it without explicit written permission. See `LICENSE`.
