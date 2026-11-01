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

## One-line installation

Run this on a supported Linux VPS:

```bash
sudo bash -c 'tmp=$(mktemp /tmp/.sgm-installer.XXXXXX.sh); trap "rm -f \"$tmp\"" EXIT INT TERM; curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | tr -d "\r" > "$tmp"; bash "$tmp"'
```

The installer downloads the project, installs dependencies, creates a stable node config and starts the services with pm2. It includes a TUI menu for installing the node, installing the web control plane, and checking status. The main menu also shows the detected machine type, CPU, GPU, RAM and root disk usage.

### Non-root usage

If you do not have root access, you can run the installer without sudo:

```bash
bash -c 'tmp=$(mktemp /tmp/.sgm-installer.XXXXXX.sh); trap "rm -f \"$tmp\"" EXIT INT TERM; curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | tr -d "\r" > "$tmp"; bash "$tmp"'
```

In non-root mode it installs into your home directory and skips system package installation where possible. The installer is designed to continue safely without root, but full system installation is recommended with sudo.

## License

This project is proprietary software owned by SGM. You may not modify, redistribute, sublicense or reverse engineer it without explicit written permission. See `LICENSE`.
