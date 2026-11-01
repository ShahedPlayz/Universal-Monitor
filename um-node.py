#!/usr/bin/env python3
"""Universal Monitor node agent.

A tiny, dependency-free HTTP API that exposes live system metrics, a shell
terminal and power controls to the Universal Monitor website.

Run ``python3 um-node.py --help`` for the CLI.  A node is identified by a
stable ``um-xxxxxx`` id and protected by an API key.  The agent can run on any
Linux host; metrics are read straight from /proc and /sys.
"""

from __future__ import annotations

import argparse
import base64
import hmac
import json
import logging
import os
import queue
import platform
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

VERSION = "1.0.0"
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_NODES_DIR = BASE_DIR / "nodes"
PROC = "/proc"
THERMAL_DIR = "/sys/class/thermal"

log = logging.getLogger("um-node")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def read_lines(path: str) -> list[str]:
    data = read(path)
    return data.splitlines() if data else []


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def round1(value: float | None) -> float | None:
    return None if value is None else round(float(value), 1)


def round2(value: float | None) -> float | None:
    return None if value is None else round(float(value), 2)


def find_free_port(host: str = "0.0.0.0") -> int:
    """Ask the kernel for an unused TCP port."""
    bind_host = "" if host in ("0.0.0.0", "::", "*") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((bind_host, 0))
        return int(sock.getsockname()[1])


def port_available(host: str, port: int) -> bool:
    if port <= 0:
        return False
    bind_host = "" if host in ("0.0.0.0", "::", "*") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((bind_host, port))
            return True
        except OSError:
            return False


# --------------------------------------------------------------------------- #
# CPU
# --------------------------------------------------------------------------- #

class CpuSampler:
    def __init__(self) -> None:
        self._prev_total, self._prev_cores = self._times()

    @staticmethod
    def _times() -> tuple[tuple[float, float], list[tuple[float, float]]]:
        aggregate = (0.0, 0.0)
        cores: list[tuple[float, float]] = []
        for line in read_lines(f"{PROC}/stat"):
            if not line.startswith("cpu"):
                continue
            parts = line.split()
            try:
                values = [float(v) for v in parts[1:]]
            except ValueError:
                continue
            idle = values[3] + (values[4] if len(values) > 4 else 0.0)
            total = sum(values)
            if parts[0] == "cpu":
                aggregate = (total, idle)
            else:
                cores.append((total, idle))
        return aggregate, cores

    @staticmethod
    def _usage(prev: tuple[float, float], curr: tuple[float, float]) -> float:
        delta_total = curr[0] - prev[0]
        delta_idle = curr[1] - prev[1]
        if delta_total <= 0:
            return 0.0
        return round1(clamp((1.0 - delta_idle / delta_total) * 100.0)) or 0.0

    def sample(self) -> dict[str, Any]:
        total, cores = self._times()
        overall = self._usage(self._prev_total, total)
        per_core = [self._usage(p, c) for p, c in zip(self._prev_cores, cores)]
        self._prev_total, self._prev_cores = total, cores
        try:
            load = [float(x) for x in (read(f"{PROC}/loadavg") or "").split()[:3]]
        except ValueError:
            load = [0.0, 0.0, 0.0]
        while len(load) < 3:
            load.append(0.0)
        return {
            "overall": overall,
            "cores": per_core,
            "logical_cores": len(cores) or (os.cpu_count() or 1),
            "load": [round2(x) for x in load],
        }


def cpu_model() -> str:
    for line in read_lines(f"{PROC}/cpuinfo"):
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        if key.strip() in ("model name", "Hardware", "Processor", "cpu model"):
            value = value.strip()
            if value:
                return value
    return platform.machine() or "CPU"


# --------------------------------------------------------------------------- #
# Machine identity
# --------------------------------------------------------------------------- #

_DEVICE_MODEL_PATHS = (
    "/proc/device-tree/model",
    "/sys/firmware/devicetree/base/model",
)
_DMI_MODEL_PATHS = (
    "/sys/class/dmi/id/product_name",
    "/sys/class/dmi/id/board_name",
)
_DMI_VENDOR_PATHS = (
    "/sys/class/dmi/id/sys_vendor",
    "/sys/class/dmi/id/board_vendor",
)


def _first_text(paths: tuple[str, ...]) -> str:
    for path in paths:
        value = read(path)
        if value:
            value = value.replace("\x00", " ").strip()
            if value and value.lower() not in ("to be filled by o.e.m.", "system product name", "default string"):
                return value
    return ""


def device_model() -> str:
    return _first_text(_DEVICE_MODEL_PATHS) or _first_text(_DMI_MODEL_PATHS)


def device_vendor() -> str:
    return _first_text(_DMI_VENDOR_PATHS)


def machine_type(model: str = "", vendor: str = "") -> str:
    text = f"{model} {vendor} {platform.machine()} {cpu_model()}".lower()
    container = os.path.exists("/.dockerenv") or bool(read("/run/systemd/container"))
    cgroup = (read("/proc/1/cgroup") or "").lower()
    if container or "docker" in cgroup or "lxc" in cgroup or "kubepods" in cgroup:
        return "Container"
    if any(word in text for word in (
        "kvm", "qemu", "vmware", "virtualbox", "hyper-v", "xen", "bochs",
        "virtual machine", "openstack", "digitalocean", "linode",
    )):
        return "Virtual Machine"
    if any(word in text for word in (
        "x96", "tx3", "tx5", "tx6", "tx9", "tx20", "tx 20", "h96", "h616", "h618",
        "s905", "s912", "s922", "amlogic", "allwinner", "sun50i", "tanix", "beelink",
        "minix", "magicsee", "ugoos", "tv box", "android box",
    )):
        return "TV Box"
    if any(word in text for word in (
        "raspberry pi", "orange pi", "banana pi", "rock pi", "nanopi", "odroid",
        "radxa", "khadas", "pine64", "tinker board", "single board",
    )):
        return "Single Board Computer"
    if any(word in text for word in ("laptop", "notebook", "thinkpad", "ideapad")):
        return "Laptop"
    if any(word in text for word in ("server", "poweredge", "proliant", "rack")):
        return "Server"
    if any(word in text for word in ("aarch64", "armv7", "armv6", "arm64")):
        return "ARM Device"
    return "Desktop"


def machine_info() -> dict[str, str]:
    model = device_model() or "Unknown"
    vendor = device_vendor()
    return {
        "model": model,
        "vendor": vendor or "Unknown",
        "type": machine_type(model, vendor),
        "architecture": platform.machine() or "unknown",
        "hostname": socket.gethostname(),
    }


# --------------------------------------------------------------------------- #
# Memory
# --------------------------------------------------------------------------- #

_MEM_KEYS = {
    "MemTotal": "total",
    "MemAvailable": "available",
    "MemFree": "free",
    "Buffers": "buffers",
    "Cached": "cached",
    "SReclaimable": "reclaimable",
    "SwapTotal": "swap_total",
    "SwapFree": "swap_free",
}


def read_memory() -> dict[str, Any]:
    values: dict[str, int] = {}
    for line in read_lines(f"{PROC}/meminfo"):
        if ":" not in line:
            continue
        key, _, rest = line.partition(":")
        attr = _MEM_KEYS.get(key.strip())
        if not attr:
            continue
        try:
            values[attr] = int(rest.split()[0]) * 1024
        except (IndexError, ValueError):
            continue

    total = values.get("total", 0)
    available = values.get("available")
    if available is None:
        available = values.get("free", 0) + values.get("buffers", 0) + values.get("cached", 0)
    swap_total = values.get("swap_total", 0)
    swap_free = values.get("swap_free", 0)
    used = max(0, total - available)
    return {
        "total": total,
        "available": available,
        "used": used,
        "cached": values.get("cached", 0) + values.get("reclaimable", 0),
        "buffers": values.get("buffers", 0),
        "swap_total": swap_total,
        "swap_used": max(0, swap_total - swap_free),
        "percent": round1((used / total) * 100.0) if total else 0.0,
        "swap_percent": round1(((swap_total - swap_free) / swap_total) * 100.0) if swap_total else 0.0,
    }


# --------------------------------------------------------------------------- #
# Disk
# --------------------------------------------------------------------------- #

PSEUDO_FS = frozenset({
    "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs",
    "devpts", "devtmpfs", "efivarfs", "fuse.gvfsd-fuse", "fusectl", "hugetlbfs",
    "mqueue", "nsfs", "proc", "pstore", "ramfs", "rpc_pipefs", "securityfs",
    "squashfs", "sysfs", "tmpfs", "tracefs", "overlay",
})
REAL_FS = frozenset({
    "btrfs", "exfat", "ext2", "ext3", "ext4", "f2fs", "jfs", "nilfs2",
    "ntfs", "ntfs3", "reiserfs", "ufs", "vfat", "xfs", "zfs",
})


def read_disks() -> list[dict[str, Any]]:
    candidates: dict[str, tuple[str, str, str]] = {}
    for line in read_lines(f"{PROC}/self/mountinfo"):
        parts = line.split()
        try:
            sep = parts.index("-")
        except ValueError:
            continue
        if len(parts) < sep + 3 or len(parts) < 5:
            continue
        mount = parts[4].replace("\\040", " ")
        fstype = parts[sep + 1]
        source = parts[sep + 2]
        if fstype in PSEUDO_FS:
            continue
        if not source.startswith("/dev/") and fstype not in REAL_FS:
            continue
        key = source if source.startswith("/dev/") else f"{fstype}:{mount}"
        current = candidates.get(key)
        if current is None or len(mount) < len(current[0]):
            candidates[key] = (mount, fstype, source)

    disks: list[dict[str, Any]] = []
    for mount, fstype, source in candidates.values():
        if not os.path.isdir(mount):
            continue
        try:
            stat = os.statvfs(mount)
        except OSError:
            continue
        block = stat.f_frsize or stat.f_bsize or 0
        total = stat.f_blocks * block
        used = (stat.f_blocks - stat.f_bfree) * block
        if total <= 0:
            continue
        disks.append({
            "mount": mount,
            "device": source or "?",
            "fstype": fstype,
            "total": total,
            "used": used,
            "free": stat.f_bavail * block,
            "percent": round1((used / total) * 100.0),
        })
    disks.sort(key=lambda d: d["percent"], reverse=True)
    return disks[:12]


# --------------------------------------------------------------------------- #
# Network
# --------------------------------------------------------------------------- #

class ProtocolSampler:
    NAMES = ("tcp", "udp", "icmp", "icmp6", "other")

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.counters = {"rx": {name: 0 for name in self.NAMES}, "tx": {name: 0 for name in self.NAMES}}
        self.available = False
        self._sock = None
        try:
            self._sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
        except OSError:
            return
        self.available = True
        threading.Thread(target=self._run, name="um-protocols", daemon=True).start()

    def _run(self) -> None:
        sock = self._sock
        while sock is not None:
            try:
                data, addr = sock.recvfrom(65535)
            except OSError:
                break
            try:
                self._account(data, addr)
            except Exception:
                continue

    def _account(self, data: bytes, addr: tuple[Any, ...]) -> None:
        if len(data) < 14 or addr[0] == "lo":
            return
        direction = "tx" if addr[2] == socket.PACKET_OUTGOING else "rx"
        ether_type = struct.unpack("!H", data[12:14])[0]
        offset = 14
        while ether_type in (0x8100, 0x88A8) and len(data) >= offset + 4:
            ether_type = struct.unpack("!H", data[offset + 2:offset + 4])[0]
            offset += 4
        if ether_type == 0x0800:
            if len(data) < offset + 20:
                return
            header_len = (data[offset] & 0x0F) * 4
            if header_len < 20 or len(data) < offset + header_len:
                return
            total_len = struct.unpack("!H", data[offset + 2:offset + 4])[0]
            protocol = data[offset + 9]
            length = total_len or (len(data) - offset)
        elif ether_type == 0x86DD:
            if len(data) < offset + 40:
                return
            length = struct.unpack("!H", data[offset + 4:offset + 6])[0] + 40
            protocol = data[offset + 6]
        else:
            return
        name = {6: "tcp", 17: "udp", 1: "icmp", 58: "icmp6"}.get(protocol, "other")
        with self.lock:
            self.counters[direction][name] += length

    def totals(self) -> dict[str, dict[str, int]]:
        with self.lock:
            return {direction: dict(values) for direction, values in self.counters.items()}


class NetworkSampler:
    def __init__(self) -> None:
        self._prev_rx, self._prev_tx = self._totals()
        self._prev_ts = time.monotonic()
        self._protocols = ProtocolSampler()
        self._prev_protocols = self._protocols.totals()

    @staticmethod
    def _totals() -> tuple[int, int]:
        rx = tx = 0
        for line in read_lines(f"{PROC}/net/dev"):
            if ":" not in line:
                continue
            iface, _, rest = line.partition(":")
            if iface.strip() == "lo":
                continue
            cols = rest.split()
            try:
                rx += int(cols[0])
                tx += int(cols[8])
            except (IndexError, ValueError):
                continue
        return rx, tx

    def sample(self) -> dict[str, Any]:
        rx, tx = self._totals()
        protocols = self._protocols.totals()
        now = time.monotonic()
        elapsed = max(0.001, now - self._prev_ts)
        protocol_rates: dict[str, dict[str, Any]] = {}
        for name in ProtocolSampler.NAMES:
            rx_delta = max(0, protocols["rx"][name] - self._prev_protocols["rx"][name])
            tx_delta = max(0, protocols["tx"][name] - self._prev_protocols["tx"][name])
            protocol_rates[name] = {
                "rx_bytes": protocols["rx"][name],
                "tx_bytes": protocols["tx"][name],
                "rx_per_sec": round1(rx_delta / elapsed),
                "tx_per_sec": round1(tx_delta / elapsed),
            }
        result = {
            "rx_bytes": rx,
            "tx_bytes": tx,
            "total_rx_bytes": rx,
            "total_tx_bytes": tx,
            "rx_per_sec": max(0.0, (rx - self._prev_rx) / elapsed),
            "tx_per_sec": max(0.0, (tx - self._prev_tx) / elapsed),
            "protocols": protocol_rates,
            "protocols_available": self._protocols.available,
            "since": "boot",
        }
        self._prev_rx, self._prev_tx, self._prev_ts = rx, tx, now
        self._prev_protocols = protocols
        result["rx_per_sec"] = round1(result["rx_per_sec"])
        result["tx_per_sec"] = round1(result["tx_per_sec"])
        return result


# --------------------------------------------------------------------------- #
# GPU - adapted from SGM-System-Monitor
# --------------------------------------------------------------------------- #

GPU_DRM_DRIVERS = {
    "panfrost", "lima", "mali", "mali_kbase", "msm", "kgsl", "etnaviv",
    "nouveau", "amdgpu", "radeon", "i915", "xe", "v3d", "vc4", "tegra",
    "virtio_gpu", "vmwgfx", "qxl",
}
_DISPLAY_DRM_DRIVERS = {
    "sun4i-drm", "sun8i-drm", "meson", "meson-drm", "rockchipdrm",
    "rockchip-drm", "msm_dpu", "msm_dsi", "simple-framebuffer", "fbdev",
}
SOC_GPU_NAMES = {
    "sun50i-h616": "Mali-G31",
    "sun50i-h618": "Mali-G52",
    "sun50i-h616s": "Mali-G31",
    "sun8i-h616": "Mali-G31",
    "sun50i-h6": "Mali-T720",
    "sun50i-h5": "Mali-450",
    "sun50i-a64": "Mali-T760",
    "sun8i-h3": "Mali-400",
    "meson-g12a": "Mali-G31",
    "meson-g12b": "Mali-G52",
    "meson-gxm": "Mali-T820",
    "meson-gxbb": "Mali-450",
    "meson-gxl": "Mali-450",
    "rk3399": "Mali-T860",
    "rk3328": "Mali-450",
    "rk3326": "Mali-G31",
    "rk3566": "Mali-G52",
    "rk3568": "Mali-G52",
    "rk3588": "Mali-G610",
    "bcm2711": "VideoCore VI",
    "bcm2837": "VideoCore IV",
    "bcm2835": "VideoCore IV",
    "tegra": "NVIDIA Tegra",
    "qcom,msm": "Adreno",
}
GPU_VENDOR_NAMES = {
    "0x10de": "NVIDIA GPU",
    "0x1002": "AMD Radeon GPU",
    "0x8086": "Intel GPU",
    "0x13b5": "ARM Mali GPU",
    "0x5143": "Qualcomm Adreno GPU",
    "0x14e4": "Broadcom VideoCore GPU",
}
GPU_PROBE_BIN = os.environ.get("UM_GPU_PROBE") or str(BASE_DIR / "gpu_probe")
GPU_PROBE_FRAMES = int(os.environ.get("UM_GPU_PROBE_FRAMES", "6"))
GPU_PROBE_CACHE_SECONDS = 2.0
GPU_PROBE_LOAD_SCALE = 1.2
_probe_cache: dict[str, Any] = {"ts": 0.0, "ms": None}
_probe_lock = threading.Lock()


def _number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _nvidia() -> dict[str, Any] | None:
    binary = shutil.which("nvidia-smi")
    if not binary:
        return None
    try:
        proc = subprocess.run(
            [binary, "--query-gpu=name,utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        return None
    cols = [c.strip() for c in lines[0].split(",")]
    util = _number(cols[1]) if len(cols) > 1 else None
    mem_used = _number(cols[2]) if len(cols) > 2 else None
    mem_total = _number(cols[3]) if len(cols) > 3 else None
    return {
        "name": cols[0] or "NVIDIA GPU",
        "utilization": round1(util),
        "memory_used": int(mem_used * 1024 * 1024) if mem_used else None,
        "memory_total": int(mem_total * 1024 * 1024) if mem_total else None,
        "detail": "nvidia-smi",
        "users": 0,
    }


def _pci_gpu_name() -> str:
    binary = shutil.which("lspci")
    if not binary:
        return ""
    try:
        proc = subprocess.run([binary], capture_output=True, text=True, timeout=4)
    except (subprocess.SubprocessError, OSError):
        return ""
    for line in proc.stdout.splitlines():
        low = line.lower()
        if not any(word in low for word in ("vga compatible", "3d controller", "display controller")):
            continue
        name = line.split(": ", 1)[1] if ": " in line else line
        for prefix in ("VGA compatible controller: ", "3D controller: ", "Display controller: "):
            if name.startswith(prefix):
                name = name[len(prefix):]
        return name.strip()
    return ""


def _drm_attr(card: str, attr: str) -> str:
    return (read(f"/sys/class/drm/{card}/device/{attr}") or "").strip()


def _drm_gpu_cards() -> list[tuple[str, str]]:
    cards: list[tuple[str, str]] = []
    try:
        entries = sorted(os.listdir("/sys/class/drm"))
    except OSError:
        return cards
    for entry in entries:
        if not entry.startswith("card") or "-" in entry:
            continue
        driver = os.path.basename(os.path.realpath(f"/sys/class/drm/{entry}/device/driver"))
        if driver in _DISPLAY_DRM_DRIVERS or driver not in GPU_DRM_DRIVERS:
            continue
        cards.append((entry, driver))
    return cards


def _drm_busy() -> tuple[int, int, bool]:
    total_ns = 0
    clients = 0
    accounted = False
    try:
        pids = os.listdir(PROC)
    except OSError:
        return 0, 0, False
    for pid in pids:
        if not pid.isdigit():
            continue
        fd_dir = f"{PROC}/{pid}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                if not os.readlink(f"{fd_dir}/{fd}").startswith("/dev/dri/renderD"):
                    continue
            except OSError:
                continue
            clients += 1
            try:
                with open(f"{PROC}/{pid}/fdinfo/{fd}", "r", encoding="utf-8") as fh:
                    for line in fh:
                        if line.startswith("drm-engine-"):
                            _, _, raw = line.partition(":")
                            total_ns += int(raw.strip())
                            accounted = True
            except (OSError, ValueError):
                continue
    return total_ns, clients, accounted


def _probe_gpu(frames: int = GPU_PROBE_FRAMES) -> float | None:
    binary = GPU_PROBE_BIN
    if not binary or not os.path.isfile(binary):
        return None
    with _probe_lock:
        if _probe_cache["ms"] is not None and time.monotonic() - float(_probe_cache["ts"]) < GPU_PROBE_CACHE_SECONDS:
            return _probe_cache["ms"]
        try:
            proc = subprocess.run([binary, str(frames)], capture_output=True, text=True, timeout=15)
            value = float(proc.stdout.strip())
        except (FileNotFoundError, PermissionError, subprocess.SubprocessError, ValueError):
            return None
        if value <= 0:
            return None
        _probe_cache["ts"] = time.monotonic()
        _probe_cache["ms"] = value
        return value


def _soc_string() -> str:
    return (read(f"{PROC}/device-tree/compatible") or "").replace("\x00", " ").lower()


class GpuSampler:
    def __init__(self) -> None:
        self._prev_ns: int | None = None
        self._prev_ts = time.monotonic()
        self._accounted = False
        self._baseline_ms: float | None = None

    def sample(self) -> dict[str, Any]:
        nvidia = _nvidia()
        if nvidia is not None:
            return nvidia

        cards = _drm_gpu_cards()
        if not cards:
            pci_name = _pci_gpu_name()
            if pci_name:
                return {"name": pci_name, "utilization": None, "memory_used": None,
                        "memory_total": None, "detail": "PCI GPU (driver not loaded)", "users": 0}
            return {"name": "GPU does not exist", "utilization": None, "memory_used": None,
                    "memory_total": None, "detail": "no GPU detected", "users": 0}

        card, driver = cards[0]
        soc = _soc_string()
        core = next((v for k, v in SOC_GPU_NAMES.items() if k in soc), "")
        vendor = _drm_attr(card, "vendor").lower()
        if not core:
            core = GPU_VENDOR_NAMES.get(vendor, "")
        pci_name = _pci_gpu_name()
        if pci_name and (vendor in GPU_VENDOR_NAMES or not core):
            name = pci_name
        elif core:
            name = f"{core} ({driver})"
        else:
            name = f"GPU ({driver})"

        busy_ns, clients, accounted = _drm_busy()
        if accounted:
            self._accounted = True
        now = time.monotonic()
        elapsed = now - self._prev_ts
        self._prev_ts = now

        utilization: float | None = None
        probe_ms: float | None = None
        if self._accounted and self._prev_ns is not None and elapsed > 0:
            delta = max(0, busy_ns - self._prev_ns)
            utilization = round1(clamp((delta / (elapsed * 1e9)) * 100.0))
        else:
            probe_ms = _probe_gpu()
            if probe_ms is not None and clients == 0:
                if self._baseline_ms is None or probe_ms < self._baseline_ms:
                    self._baseline_ms = probe_ms
            if clients == 0:
                utilization = 0.0
            elif probe_ms is None and self._baseline_ms is not None:
                utilization = 100.0
            elif probe_ms is not None and probe_ms > 0 and self._baseline_ms:
                utilization = round1(clamp(100.0 * (1.0 - self._baseline_ms / probe_ms) * GPU_PROBE_LOAD_SCALE))
            else:
                utilization = 0.0
        self._prev_ns = busy_ns

        memory_used = None
        memory_total = None
        busy_sysfs = _drm_attr(card, "gpu_busy_percent")
        if busy_sysfs:
            try:
                utilization = round1(clamp(float(busy_sysfs)))
            except ValueError:
                pass
        vram_used = _drm_attr(card, "mem_info_vram_used")
        vram_total = _drm_attr(card, "mem_info_vram_total")
        if vram_used.isdigit() and vram_total.isdigit():
            memory_used = int(vram_used)
            memory_total = int(vram_total)

        detail = f"{card} | {clients} client(s)"
        if clients == 0:
            detail += " | idle"
        elif self._accounted:
            detail += " | active"
        elif probe_ms is not None and self._baseline_ms is not None:
            detail += f" | probe {probe_ms:.0f}ms/{self._baseline_ms:.0f}ms"
        elif probe_ms is not None:
            detail += f" | probe {probe_ms:.0f}ms (calibrating)"
        elif self._baseline_ms is not None:
            detail += " | probe timed out (saturated)"
        else:
            detail += " | no busy counter in driver"

        return {"name": name, "utilization": utilization, "memory_used": memory_used,
                "memory_total": memory_total, "detail": detail, "users": clients}


# --------------------------------------------------------------------------- #
# Thermal
# --------------------------------------------------------------------------- #

ZONE_LABELS = {"cpu": "CPU", "gpu": "GPU", "ddr": "DDR", "ve": "VE", "soc": "SoC"}


def _zone_label(name: str) -> str:
    key = name[:-8] if name.endswith("-thermal") else name
    return ZONE_LABELS.get(key, key.upper())


class ThermalSampler:
    NOISE = 0.3

    def __init__(self) -> None:
        self._prev: dict[str, float] = {}

    def sample(self) -> dict[str, Any]:
        zones: list[dict[str, Any]] = []
        try:
            entries = sorted(os.listdir(THERMAL_DIR))
        except OSError:
            entries = []
        for entry in entries:
            if not entry.startswith("thermal_zone"):
                continue
            path = f"{THERMAL_DIR}/{entry}"
            name = (read(f"{path}/type") or entry).strip()
            raw = read(f"{path}/temp")
            try:
                temp = int((raw or "").strip()) / 1000.0
            except ValueError:
                temp = None
            trend, delta = 0, 0.0
            if temp is not None:
                previous = self._prev.get(name)
                if previous is not None:
                    delta = temp - previous
                    if abs(delta) < self.NOISE:
                        trend, delta = 0, 0.0
                    else:
                        trend = 1 if delta > 0 else -1
                self._prev[name] = temp
            zones.append({
                "name": name,
                "label": _zone_label(name),
                "temp": round1(temp),
                "trend": trend,
                "delta": round1(delta),
            })
        temps = [z["temp"] for z in zones if z["temp"] is not None]
        hottest = max(zones, key=lambda z: z["temp"] if z["temp"] is not None else -999, default=None)
        return {
            "zones": zones,
            "max": round1(max(temps)) if temps else None,
            "min": round1(min(temps)) if temps else None,
            "avg": round1(sum(temps) / len(temps)) if temps else None,
            "hottest": hottest,
        }


# --------------------------------------------------------------------------- #
# Aggregate state
# --------------------------------------------------------------------------- #

def uptime_seconds() -> float:
    try:
        return float((read(f"{PROC}/uptime") or "0").split()[0])
    except (IndexError, ValueError):
        return 0.0


class NodeState:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.lock = threading.Lock()
        self.cpu = CpuSampler()
        self.net = NetworkSampler()
        self.gpu = GpuSampler()
        self.thermal = ThermalSampler()
        self.machine = machine_info()
        self.cwd = os.environ.get("UM_TERMINAL_CWD") or "/root"
        if not os.path.isdir(self.cwd):
            self.cwd = str(Path.home())
        self.started_at = now_iso()
        self.pty_sessions = {}
        self.pty_lock = threading.Lock()

    def health(self) -> dict[str, Any]:
        with self.lock:
            cwd = self.cwd
        return {
            "ok": True,
            "node": {
                "id": self.config["id"],
                "name": self.config["name"],
                "hostname": socket.gethostname(),
                "version": VERSION,
                "uptime": round1(uptime_seconds()),
                "started_at": self.started_at,
                "cwd": cwd,
                "device_model": self.machine["model"],
                "device_vendor": self.machine["vendor"],
                "device_type": self.machine["type"],
                "architecture": self.machine["architecture"],
            },
            "time": now_iso(),
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            cpu = self.cpu.sample()
            memory = read_memory()
            disks = read_disks()
            network = self.net.sample()
            gpu = self.gpu.sample()
            thermal = self.thermal.sample()
            cwd = self.cwd
        return {
            "ok": True,
            "node": {
                "id": self.config["id"],
                "name": self.config["name"],
                "hostname": socket.gethostname(),
                "version": VERSION,
                "uptime": round1(uptime_seconds()),
                "started_at": self.started_at,
                "cwd": cwd,
                "kernel": platform.release(),
                "machine": platform.machine(),
                "cpu_model": cpu_model(),
                "device_model": self.machine["model"],
                "device_vendor": self.machine["vendor"],
                "device_type": self.machine["type"],
                "architecture": self.machine["architecture"],
            },
            "cpu": cpu,
            "memory": memory,
            "disks": disks,
            "network": network,
            "gpu": gpu,
            "thermal": thermal,
            "time": now_iso(),
        }

    def run_terminal(self, command: str, timeout: int) -> dict[str, Any]:
        command = command.strip()
        if not command:
            return {"ok": False, "error": "Empty command"}
        if len(command) > 8000:
            return {"ok": False, "error": "Command is too long (max 8000 characters)"}

        with self.lock:
            cwd = self.cwd

        # A bare ``cd`` is a terminal convenience: remember the directory for
        # the next command instead of losing it with the shell process.
        if command.startswith("cd ") and "&&" not in command and ";" not in command:
            target = command[3:].strip().strip("'\"")
            target = os.path.expanduser(target)
            new_cwd = target if os.path.isabs(target) else os.path.normpath(os.path.join(cwd, target))
            if os.path.isdir(new_cwd):
                with self.lock:
                    self.cwd = new_cwd
                return {"ok": True, "stdout": "", "stderr": "", "exit_code": 0,
                        "duration_ms": 0, "cwd": new_cwd, "timed_out": False}
            return {"ok": False, "error": f"cd: no such directory: {target}", "cwd": cwd}

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env["COLUMNS"] = "120"
        started = time.monotonic()
        timed_out = False
        try:
            proc = subprocess.Popen(
                ["/bin/bash", "-lc", command],
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                errors="replace",
                env=env,
                start_new_session=True,
            )
        except OSError as exc:
            return {"ok": False, "error": str(exc), "cwd": cwd}

        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                stdout, stderr = proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", ""
        duration_ms = int((time.monotonic() - started) * 1000)
        with self.lock:
            final_cwd = self.cwd
        return {
            "ok": proc.returncode == 0 and not timed_out,
            "stdout": stdout or "",
            "stderr": stderr or "",
            "exit_code": proc.returncode,
            "duration_ms": duration_ms,
            "cwd": final_cwd,
            "timed_out": timed_out,
        }

    # ------------------------------------------------------------------ #
    # interactive PTY (used by BTOP++ and other full-screen terminal apps)
    # ------------------------------------------------------------------ #
    def _set_winsize(self, fd: int, cols: int, rows: int) -> None:
        import fcntl, struct, termios
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except (OSError, ValueError):
            pass

    def start_pty(self, command: str, cols: int = 120, rows: int = 32) -> dict[str, Any]:
        command = (command or "").strip() or "btop"
        if len(command) > 8000:
            return {"ok": False, "error": "Command is too long (max 8000 characters)"}
        if command == "btop" or command.startswith("btop "):
            resolved = shutil.which("btop")
            if not resolved:
                for candidate in ("/usr/bin/btop", "/usr/local/bin/btop", "/bin/btop", "/usr/sbin/btop"):
                    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                        resolved = candidate
                        break
            if not resolved:
                return {"ok": False, "error": "btop is not installed on this node. Run api-installer.sh to install it."}
            command = resolved + command[4:]
        with self.lock:
            cwd = self.cwd
        import os as _os, pty, subprocess, threading, queue, select, time as _t
        master, slave = pty.openpty()
        self._set_winsize(master, cols, rows)
        self._set_winsize(slave, cols, rows)
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        try:
            proc = subprocess.Popen(
                ["/bin/bash", "-lc", command],
                stdin=slave, stdout=slave, stderr=slave,
                cwd=cwd, env=env, start_new_session=True, close_fds=True,
            )
        except OSError as exc:
            try:
                _os.close(master); _os.close(slave)
            except OSError:
                pass
            return {"ok": False, "error": str(exc), "cwd": cwd}
        _os.close(slave)
        sid = secrets.token_hex(8)
        session = {
            "id": sid, "proc": proc, "master": master, "cols": cols, "rows": rows,
            "cwd": cwd, "started": _t.monotonic(), "closed": False,
            "output": queue.Queue(), "lock": threading.Lock(),
        }
        def reader() -> None:
            while True:
                try:
                    r, _, _ = select.select([master], [], [], 0.5)
                except (OSError, ValueError):
                    break
                if master in r:
                    try:
                        data = _os.read(master, 4096)
                    except OSError:
                        data = b""
                    if data == b"":
                        if proc.poll() is not None:
                            break
                        time.sleep(0.1)
                        continue
                    session["output"].put(data)
                if proc.poll() is not None:
                    # drain anything left
                    try:
                        while True:
                            r2, _, _ = select.select([master], [], [], 0.1)
                            if master not in r2:
                                break
                            data = _os.read(master, 4096)
                            if not data:
                                break
                            session["output"].put(data)
                    except OSError:
                        pass
                    break
            session["closed"] = True
            try:
                session["output"].put(None)
            except Exception:
                pass
            try:
                _os.close(master)
            except OSError:
                pass
        threading.Thread(target=reader, daemon=True).start()
        with self.pty_lock:
            self.pty_sessions[sid] = session
        return {"ok": True, "session": sid, "command": command, "cols": cols, "rows": rows, "cwd": cwd}

    def pty_input(self, session_id: str, data: str = "", data_b64: str | None = None) -> dict[str, Any]:
        session = self._pty_session(session_id)
        if session is None:
            return {"ok": False, "error": "Unknown session"}
        payload = data.encode("utf-8", errors="replace") if data_b64 is None else base64.b64decode(data_b64, validate=False)
        try:
            os.write(session["master"], payload)
        except OSError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True}

    def pty_resize(self, session_id: str, cols: int, rows: int) -> dict[str, Any]:
        session = self._pty_session(session_id)
        if session is None:
            return {"ok": False, "error": "Unknown session"}
        cols = max(2, min(300, int(cols or session["cols"])))
        rows = max(1, min(200, int(rows or session["rows"])))
        session["cols"] = cols
        session["rows"] = rows
        self._set_winsize(session["master"], cols, rows)
        try:
            import signal as _signal
            os.killpg(session["proc"].pid, _signal.SIGWINCH)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        return {"ok": True, "cols": cols, "rows": rows}

    def pty_stop(self, session_id: str) -> dict[str, Any]:
        session = self._pty_session(session_id, remove=True)
        if session is None:
            return {"ok": False, "error": "Unknown session"}
        proc = session["proc"]
        try:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
        try:
            os.close(session["master"])
        except OSError:
            pass
        return {"ok": True, "exit_code": proc.returncode}

    def pty_read(self, session_id: str, timeout: float = 0.5) -> tuple[bytes | None, bool]:
        session = self._pty_session(session_id)
        if session is None:
            return None, True
        try:
            chunk = session["output"].get(timeout=timeout)
        except queue.Empty:
            chunk = b""
        if chunk is None:
            return b"", True
        proc_done = session["proc"].poll() is not None
        closed = proc_done and session["output"].empty()
        return chunk, closed

    def _pty_session(self, session_id: str, remove: bool = False) -> dict[str, Any] | None:
        with self.pty_lock:
            session = self.pty_sessions.get(session_id)
            if session is not None and remove:
                self.pty_sessions.pop(session_id, None)
            return session


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

def new_node_id(config_dir: Path) -> str:
    while True:
        node_id = "um-" + secrets.token_hex(3)
        if not (config_dir / f"{node_id}.json").exists():
            return node_id


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def create_config(config_dir: Path, name: str, host: str, port: int) -> dict[str, Any]:
    config_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(config_dir, 0o700)
    node_id = new_node_id(config_dir)
    if port and not port_available(host, port):
        log.warning("port %s is busy; choosing a free port instead", port)
        port = 0
    if not port:
        port = find_free_port(host)
    config = {
        "id": node_id,
        "name": name or socket.gethostname(),
        "api_key": "umk_" + secrets.token_hex(24),
        "host": host,
        "port": port,
        "created_at": now_iso(),
    }
    write_json(config_dir / f"{node_id}.json", config)
    return config


def load_config(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("id", "name", "api_key", "host", "port"):
        if key not in data:
            raise ValueError(f"config is missing {key!r}")
    return data


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #

class NodeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler, state: NodeState) -> None:
        super().__init__(address, handler)
        self.state = state


class NodeHandler(BaseHTTPRequestHandler):
    server_version = f"UniversalMonitorNode/{VERSION}"
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> NodeState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if args and str(args[0]).startswith(("4", "5")):
            log.warning("%s - %s", self.address_string(), fmt % args)

    # -- plumbing ---------------------------------------------------------- #

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _handle_pty_stream(self) -> None:
        from urllib.parse import parse_qs, urlparse
        qs = parse_qs(urlparse(self.path).query)
        session_id = (qs.get("session") or [""])[0]
        session = self.state._pty_session(session_id)
        if session is None:
            self._error(404, "Unknown session")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last_closed = False
        while True:
            chunk, closed = self.state.pty_read(session_id, 0.5)
            if chunk is None:
                break
            if chunk:
                import base64 as _b64
                payload = _b64.b64encode(chunk).decode("ascii")
                try:
                    self.wfile.write(f"data: {payload}\n\n".encode("ascii"))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    break
            if closed:
                try:
                    self.wfile.write(b"event: close\ndata: done\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                break
            time.sleep(0.05)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"ok": False, "error": message})

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 2 * 1024 * 1024:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def _authorized(self) -> bool:
        expected = str(self.state.config.get("api_key") or "")
        supplied = self.headers.get("X-API-Key") or ""
        if not supplied:
            auth = self.headers.get("Authorization") or ""
            if auth.lower().startswith("bearer "):
                supplied = auth[7:].strip()
        if not expected or not supplied:
            return False
        return hmac.compare_digest(expected, supplied)

    def _require_auth(self) -> bool:
        if self._authorized():
            return True
        self._error(401, "Invalid or missing API key")
        return False

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/":
            self._send(200, {"ok": True, "service": "universal-monitor-node", "version": VERSION,
                             "id": self.state.config.get("id"), "name": self.state.config.get("name")})
            return
        if path not in ("/api/health", "/api/snapshot", "/api/pty/stream"):
            self._error(404, "Not found")
            return
        if not self._require_auth():
            return
        if path == "/api/pty/stream":
            self._handle_pty_stream()
            return
        try:
            if path == "/api/health":
                self._send(200, self.state.health())
            else:
                self._send(200, self.state.snapshot())
        except Exception as exc:  # defensive: never drop the agent on a bad /proc read
            log.exception("snapshot failed")
            self._error(500, f"Could not collect metrics: {exc}")

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path not in ("/api/terminal", "/api/control", "/api/pty/start", "/api/pty/input",
                       "/api/pty/resize", "/api/pty/stop"):
            self._error(404, "Not found")
            return
        if not self._require_auth():
            return
        try:
            payload = self._body()
        except ValueError as exc:
            self._error(400, str(exc))
            return

        if path == "/api/pty/start":
            command = str(payload.get("command") or "btop")
            try:
                cols = int(payload.get("cols") or 120)
                rows = int(payload.get("rows") or 32)
            except (TypeError, ValueError):
                cols, rows = 120, 32
            result = self.state.start_pty(command, cols, rows)
            self._send(200 if result.get("ok") else 400, result)
            return
        if path == "/api/pty/input":
            session = str(payload.get("session") or "")
            result = self.state.pty_input(session, str(payload.get("data") or ""),
                                         payload.get("data_b64"))
            self._send(200 if result.get("ok") else 400, result)
            return
        if path == "/api/pty/resize":
            session = str(payload.get("session") or "")
            try:
                cols = int(payload.get("cols") or 0)
                rows = int(payload.get("rows") or 0)
            except (TypeError, ValueError):
                cols, rows = 0, 0
            result = self.state.pty_resize(session, cols, rows)
            self._send(200 if result.get("ok") else 400, result)
            return
        if path == "/api/pty/stop":
            session = str(payload.get("session") or "")
            result = self.state.pty_stop(session)
            self._send(200 if result.get("ok") else 400, result)
            return
        if path == "/api/terminal":
            command = str(payload.get("command") or "")
            try:
                timeout = int(payload.get("timeout") or 30)
            except (TypeError, ValueError):
                timeout = 30
            timeout = max(1, min(120, timeout))
            result = self.state.run_terminal(command, timeout)
            self._send(200 if result.get("ok") else 200, result)
            return

        action = str(payload.get("action") or "").lower()
        confirm = str(payload.get("confirm") or "")
        if action not in ("reboot", "shutdown"):
            self._error(400, "action must be 'reboot' or 'shutdown'")
            return
        expected = "REBOOT" if action == "reboot" else "SHUTDOWN"
        if confirm != expected:
            self._error(400, f"Confirmation token must be {expected}")
            return

        def later() -> None:
            time.sleep(0.8)
            cmd = ["/usr/bin/systemctl", "reboot" if action == "reboot" else "poweroff"]
            try:
                subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
            except OSError:
                fallback = ["/usr/bin/shutdown", "-r" if action == "reboot" else "-h", "now"]
                try:
                    subprocess.Popen(fallback, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True)
                except OSError as exc:
                    log.error("power action failed: %s", exc)

        threading.Thread(target=later, daemon=True).start()
        log.warning("power action requested: %s", action)
        self._send(200, {"ok": True, "message": f"{action.capitalize()} scheduled",
                         "action": action, "time": now_iso()})


# --------------------------------------------------------------------------- #
# serve
# --------------------------------------------------------------------------- #

def serve(config_path: Path, port_override: int | None = None) -> None:
    config = load_config(config_path)
    host = str(config.get("host") or "0.0.0.0")
    port = int(port_override or config.get("port") or 0)
    if port and not port_available(host, port):
        log.warning("port %s is busy; selecting a free port", port)
        port = 0
    if not port:
        port = find_free_port(host)

    state = NodeState(config)
    server = NodeServer((host, port), NodeHandler, state)
    actual_port = int(server.server_address[1])
    if actual_port != config.get("port"):
        config["port"] = actual_port
        write_json(config_path, config)

    runtime = {
        "id": config["id"],
        "name": config["name"],
        "host": host,
        "port": actual_port,
        "pid": os.getpid(),
        "started_at": now_iso(),
        "config": str(config_path),
    }
    write_json(config_path.with_suffix(".runtime.json"), runtime)

    log.info("node %s (%s) listening on %s:%s", config["id"], config["name"], host, actual_port)
    print(f"\n  Universal Monitor node ready\n"
          f"  id:       {config['id']}\n"
          f"  name:     {config['name']}\n"
          f"  address:  {host}:{actual_port}\n"
          f"  api key:  {config['api_key']}\n", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log.info("node %s stopped", config["id"])


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="um-node.py",
        description="Universal Monitor node agent",
    )
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="command")

    create = sub.add_parser("create", help="create a node config and print its credentials")
    create.add_argument("--name", default=socket.gethostname())
    create.add_argument("--host", default="0.0.0.0")
    create.add_argument("--port", type=int, default=0, help="0 = choose a free port")
    create.add_argument("--config-dir", default=str(DEFAULT_NODES_DIR))

    serve_p = sub.add_parser("serve", help="serve an existing node config")
    serve_p.add_argument("--config", required=True)
    serve_p.add_argument("--port", type=int, default=None)

    run_p = sub.add_parser("run", help="create (if needed) and serve a node")
    run_p.add_argument("--name", default=socket.gethostname())
    run_p.add_argument("--host", default="0.0.0.0")
    run_p.add_argument("--port", type=int, default=0)
    run_p.add_argument("--config-dir", default=str(DEFAULT_NODES_DIR))
    run_p.add_argument("--config", default=None)

    list_p = sub.add_parser("list", help="list node configs")
    list_p.add_argument("--config-dir", default=str(DEFAULT_NODES_DIR))
    list_p.add_argument("--show-keys", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    if not args.command:
        args.command = "run"
        args.name = socket.gethostname()
        args.host = "0.0.0.0"
        args.port = 0
        args.config_dir = str(DEFAULT_NODES_DIR)
        args.config = None

    if args.command == "create":
        config = create_config(Path(args.config_dir), args.name, args.host, args.port)
        print(json.dumps(config, indent=2))
        return 0

    if args.command == "list":
        config_dir = Path(args.config_dir)
        rows = []
        for path in sorted(config_dir.glob("um-*.json")):
            try:
                cfg = load_config(path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            rows.append({
                "id": cfg["id"], "name": cfg["name"], "host": cfg["host"],
                "port": cfg["port"],
                **({"api_key": cfg["api_key"]} if args.show_keys else {}),
                "config": str(path),
            })
        print(json.dumps(rows, indent=2))
        return 0

    if args.command == "serve":
        serve(Path(args.config), args.port)
        return 0

    if args.command == "run":
        config_path = Path(args.config) if args.config else None
        if config_path is None or not config_path.exists():
            config_dir = Path(args.config_dir)
            config = create_config(config_dir, args.name, args.host, args.port)
            config_path = config_dir / f"{config['id']}.json"
            print(f"\n  Created node config: {config_path}", flush=True)
        serve(config_path, args.port or None)
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
