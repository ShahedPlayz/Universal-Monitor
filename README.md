# Universal Monitor

Universal Monitor is a lightweight control plane for Linux nodes. It exposes live CPU, memory, disk, network, GPU and thermal metrics, an interactive web terminal, BTOP++ process monitoring, power controls and node management through a modern web dashboard.

## Features

- Real-time node metrics over WebSocket
- Interactive terminal and BTOP++ PTY
- Node management with API keys
- Themes, settings and node health checks
- Cross-platform installer TUI
- Stable ports and API keys across restarts

## One-line installation

Run this on a supported Linux VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | sudo bash
```

The installer downloads the project, installs dependencies, creates a stable node config and starts the services with pm2. It includes a TUI menu for installing the node, installing the web control plane, and checking status.

### Non-root usage

If you do not have root access, you can run the installer without sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/ShahedPlayz/Universal-Monitor/main/install.sh | bash
```

In non-root mode it installs into your home directory and skips system package installation where possible. The installer is designed to continue safely without root, but full system installation is recommended with sudo.

## License

This project is proprietary software owned by SGM. You may not modify, redistribute, sublicense or reverse engineer it without explicit written permission. See `LICENSE`.
