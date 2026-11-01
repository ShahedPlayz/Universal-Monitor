/* ==========================================================================
   Universal Monitor - frontend
   ========================================================================== */

(function () {
  "use strict";

  const BOOT = window.__BOOT__ || {
    version: "1.0.0",
    settings: { refresh_ms: 500, history_points: 90, temperature_unit: "C", compact: false, animations: true, terminal_font_size: 13, node_timeout_ms: 3000, show_grid: true, show_sparklines: true, clock_24h: true, terminal_max_lines: 600 },
    theme: "midnight",
    themes: [],
    defaults: {},
  };

  const state = {
    settings: { ...BOOT.settings },
    defaults: { ...(BOOT.defaults || BOOT.settings) },
    theme: BOOT.theme || "midnight",
    themes: BOOT.themes || [],
    nodes: [],
    nodesLoadedAt: 0,
    currentNode: null,
    currentNodeId: null,
    subscribed: false,
    snapshot: null,
    latency: null,
    nodeError: null,
    lastErrorToast: null,
    lastSnapshotAt: 0,
    fallbackActive: false,
    fallbackTimer: null,
    socket: null,
    socketConnected: false,
    view: null,
    terminals: {},
    btopSessions: {},
    collapsed: localStorage.getItem("um.sidebar.collapsed") === "1",
    lastNodeId: localStorage.getItem("um.lastNode") || null,
    routeSeq: 0,
    history: emptyHistory(),
    modal: null,
  };

  // ------------------------------------------------------------------------
  // tiny helpers
  // ------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function emptyHistory() {
    return { cpu: [], gpu: [], mem: [], rx: [], tx: [], temp: [], tempAvg: [], total: [], rxTcp: [], rxUdp: [], rxIcmp: [], rxIcmp6: [], rxOther: [], txTcp: [], txUdp: [], txIcmp: [], txIcmp6: [], txOther: [] };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!isFinite(n) || n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
  }

  function fmtRate(bytes) {
    return `${fmtBytes(bytes)}/s`;
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    if (s < 60) return `${Math.floor(s)}s`;
    const m = Math.floor(s / 60) % 60;
    const h = Math.floor(s / 3600) % 24;
    const d = Math.floor(s / 86400);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function tempValue(celsius) {
    if (celsius == null || !isFinite(Number(celsius))) return null;
    return state.settings.temperature_unit === "F" ? (Number(celsius) * 9) / 5 + 32 : Number(celsius);
  }

  function tempUnit() {
    return state.settings.temperature_unit === "F" ? "°F" : "°C";
  }

  function fmtTemp(celsius, digits = 1) {
    const value = tempValue(celsius);
    if (value == null) return "N/A";
    return `${value.toFixed(digits)}${tempUnit()}`;
  }

  function fmtTempNumber(celsius, digits = 1) {
    const value = tempValue(celsius);
    return value == null ? "—" : value.toFixed(digits);
  }

  function fmtDelta(celsius) {
    if (celsius == null) return "0.0";
    const value = state.settings.temperature_unit === "F" ? (Number(celsius) * 9) / 5 : Number(celsius);
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)}${tempUnit()}`;
  }

  function fmtClock(date) {
    const opts = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: !state.settings.clock_24h };
    return date.toLocaleTimeString([], opts);
  }

  function timeAgo(iso) {
    if (!iso) return "never";
    const then = new Date(iso).getTime();
    if (!isFinite(then)) return "never";
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function shortAddress(address) {
    return String(address || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }

  function shortCwd(cwd) {
    if (!cwd) return "~";
    return String(cwd).replace(/^\/root(?=\/|$)/, "~");
  }

  function statusClass(status) {
    return status === "online" || status === "offline" ? status : "unknown";
  }

  function getNode(id) {
    return state.nodes.find((n) => n.id === id) || null;
  }

  // ------------------------------------------------------------------------
  // icons
  // ------------------------------------------------------------------------

  const ICONS = {
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    thermometer: '<path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z"/>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2a4 4 0 0 0 4-4c0-5.5-4.5-9.4-9-9.4Z"/>',
    server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    sidebarToggle: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
    gpu: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4"/><path d="M14 14h4"/>',
    memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><line x1="7" y1="17" x2="7" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/><line x1="17" y1="17" x2="17" y2="20"/>',
    disk: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    network: '<rect x="2" y="2" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="9" y="16" width="6" height="6" rx="1"/><path d="M5 8v4a4 4 0 0 0 4 4h2"/><path d="M19 8v4a4 4 0 0 1-4 4h-2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    rotate: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  };

  function icon(name, size = 18) {
    const path = ICONS[name] || ICONS.activity;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  // ------------------------------------------------------------------------
  // api / toast / modal
  // ------------------------------------------------------------------------

  async function api(path, options = {}) {
    const opts = { ...options };
    opts.headers = { Accept: "application/json", ...(options.headers || {}) };
    if (opts.body && !opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
    const response = await fetch(path, opts);
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) {
      throw new Error((data && data.error) || `Request failed (${response.status})`);
    }
    if (data && data.ok === false && data.error && data.exit_code === undefined) {
      throw new Error(data.error);
    }
    return data || {};
  }

  function toast(message, type = "info", timeout = 4200) {
    const root = document.getElementById("toast-root");
    if (!root) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const iconName = type === "ok" ? "check" : type === "error" ? "alert" : "zap";
    el.innerHTML = `<span class="toast-icon">${icon(iconName, 17)}</span><div class="toast-text">${escapeHtml(message)}</div><button class="toast-close" aria-label="Dismiss">${icon("x", 14)}</button>`;
    root.appendChild(el);
    const remove = () => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      setTimeout(() => el.remove(), 180);
    };
    el.querySelector(".toast-close").addEventListener("click", remove);
    setTimeout(remove, timeout);
  }

  function openModal(html, { wide = false } = {}) {
    closeModal();
    const root = document.getElementById("modal-root");
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
    root.appendChild(wrap);
    state.modal = wrap;
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap || event.target.closest("[data-close]")) closeModal();
    });
    document.addEventListener("keydown", modalKeyHandler);
    return wrap;
  }

  function modalKeyHandler(event) {
    if (event.key === "Escape") closeModal();
  }

  function closeModal() {
    const root = document.getElementById("modal-root");
    if (root) root.innerHTML = "";
    state.modal = null;
    document.removeEventListener("keydown", modalKeyHandler);
  }

  function setButtonLoading(button, label = "Working…") {
    if (!button) return;
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spin" style="display:inline-flex">${icon("refresh", 15)}</span> ${escapeHtml(label)}`;
  }

  function restoreButton(button) {
    if (!button || !button.dataset.original) return;
    button.innerHTML = button.dataset.original;
    button.disabled = false;
    delete button.dataset.original;
  }

  // ------------------------------------------------------------------------
  // theme / settings
  // ------------------------------------------------------------------------

  function applyTheme(theme) {
    state.theme = theme || "midnight";
    document.documentElement.setAttribute("data-theme", state.theme);
    if (state.view && state.view.redraw) {
      setTimeout(() => state.view && state.view.redraw && state.view.redraw(), 40);
    }
  }

  function applySettings(settings) {
    state.settings = { ...state.settings, ...(settings || {}) };
    document.body.classList.toggle("no-animations", !state.settings.animations);
    document.body.classList.toggle("compact", !!state.settings.compact);
    document.body.classList.toggle("hide-grid", !state.settings.show_grid);
    document.body.classList.toggle("hide-sparklines", !state.settings.show_sparklines);
    document.documentElement.style.setProperty("--term-font-size", `${state.settings.terminal_font_size || 13}px`);
    updateLivePill();
    updateClock();
    if (state.view && state.view.settingsChanged) state.view.settingsChanged(state.settings);
    if (state.view && state.view.redraw) state.view.redraw();
  }

  async function loadNodes(force = false) {
    if (!force && state.nodes.length && Date.now() - state.nodesLoadedAt < 1500) return state.nodes;
    try {
      const data = await api("/api/nodes");
      state.nodes = data.nodes || [];
      state.nodesLoadedAt = Date.now();
      updateNodePicker();
      return state.nodes;
    } catch (error) {
      toast(`Could not load nodes: ${error.message}`, "error");
      return state.nodes;
    }
  }

  async function ensureNode(id) {
    let node = getNode(id);
    if (node) return node;
    await loadNodes(true);
    node = getNode(id);
    if (node) return node;
    try {
      const data = await api(`/api/nodes/${encodeURIComponent(id)}`);
      node = data.node;
      if (node) state.nodes.push(node);
      return node;
    } catch (_) {
      return null;
    }
  }

  // ------------------------------------------------------------------------
  // socket + fallback polling
  // ------------------------------------------------------------------------

  function initSocket() {
    if (typeof window.io !== "function") {
      startFallback();
      return;
    }
    const socket = window.io({ transports: ["websocket", "polling"], reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 5000 });
    state.socket = socket;

    socket.on("connect", () => {
      state.socketConnected = true;
      stopFallback();
      updateLivePill();
      if (state.currentNodeId && state.subscribed) {
        socket.emit("subscribe_node", { node_id: state.currentNodeId });
      }
    });

    socket.on("disconnect", () => {
      state.socketConnected = false;
      updateLivePill();
      if (state.currentNodeId) startFallback();
    });

    socket.on("snapshot", (message) => {
      if (!message || message.node_id !== state.currentNodeId) return;
      handleSnapshot(message);
    });

    socket.on("node_error", (message) => {
      if (!message || message.node_id !== state.currentNodeId) return;
      handleNodeError(message.error || "Node unreachable");
    });

    socket.on("nodes_status", (message) => {
      if (message && Array.isArray(message.statuses)) updateNodeStatuses(message.statuses);
    });

    socket.on("nodes_changed", () => {
      loadNodes(true).then(() => {
        if (location.pathname === "/nodes") renderNodesPage();
        else updateNodePicker();
      });
    });

    socket.on("settings_changed", (settings) => {
      applySettings(settings);
    });

    socket.on("theme_changed", (theme) => {
      applyTheme(theme);
      if (location.pathname === "/theme") renderThemePage();
    });
  }

  function subscribeNode(id) {
    if (state.currentNodeId === id && state.subscribed) {
      if (state.snapshot && state.view && state.view.update) state.view.update(state.snapshot);
      return;
    }
    if (state.currentNodeId && state.currentNodeId !== id) unsubscribeNode();
    state.currentNodeId = id;
    state.subscribed = true;
    state.lastNodeId = id;
    localStorage.setItem("um.lastNode", id);
    state.snapshot = null;
    state.nodeError = null;
    state.lastErrorToast = null;
    state.lastSnapshotAt = 0;
    state.history = emptyHistory();
    updateNodePicker();
    if (state.socketConnected && state.socket) {
      state.socket.emit("subscribe_node", { node_id: id });
      stopFallback();
    } else {
      startFallback();
    }
  }

  function unsubscribeNode() {
    if (state.currentNodeId && state.socketConnected && state.socket) {
      state.socket.emit("unsubscribe_node", { node_id: state.currentNodeId });
    }
    stopFallback();
    state.currentNodeId = null;
    state.subscribed = false;
    state.snapshot = null;
    state.nodeError = null;
    state.latency = null;
    state.lastSnapshotAt = 0;
    state.history = emptyHistory();
  }

  function startFallback() {
    if (state.fallbackTimer || !state.currentNodeId) return;
    const tick = async () => {
      if (state.socketConnected || !state.currentNodeId) {
        state.fallbackTimer = null;
        return;
      }
      try {
        const data = await api(`/api/nodes/${encodeURIComponent(state.currentNodeId)}/snapshot`);
        state.fallbackActive = true;
        handleSnapshot({
          node_id: state.currentNodeId,
          data: data.data,
          latency_ms: data.latency_ms,
          received_at: data.received_at,
        });
      } catch (error) {
        state.fallbackActive = false;
        handleNodeError(error.message);
      }
      if (!state.socketConnected && state.currentNodeId) {
        state.fallbackTimer = setTimeout(tick, Math.max(250, state.settings.refresh_ms));
      } else {
        state.fallbackTimer = null;
      }
    };
    state.fallbackTimer = setTimeout(tick, 0);
  }

  function stopFallback() {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
    state.fallbackActive = false;
  }

  // ------------------------------------------------------------------------
  // snapshot handling
  // ------------------------------------------------------------------------

  function handleSnapshot(message) {
    const data = message.data || {};
    state.snapshot = data;
    state.latency = message.latency_ms;
    state.lastSnapshotAt = Date.now();
    state.nodeError = null;
    hideNodeError();
    const node = getNode(state.currentNodeId);
    if (node) {
      node.last_status = "online";
      node.last_latency_ms = message.latency_ms;
      node.last_seen = message.received_at || new Date().toISOString();
    }
    pushHistory(data);
    updateLivePill();
    updateHeaderStatus();
    if (state.view && state.view.update) state.view.update(data);
  }

  function handleNodeError(error) {
    state.nodeError = error;
    showNodeError(error);
    updateLivePill();
    updateHeaderStatus();
    if (state.view && state.view.error) state.view.error(error);
    if (state.lastErrorToast !== error) {
      state.lastErrorToast = error;
      toast(`Node error: ${error}`, "error", 5200);
    }
  }

  function pushHistory(data) {
    const cap = Math.max(20, Number(state.settings.history_points) || 90);
    const h = state.history;
    const push = (key, value) => {
      h[key].push(value == null || !isFinite(Number(value)) ? null : Number(value));
      while (h[key].length > cap) h[key].shift();
    };
    push("cpu", data.cpu && data.cpu.overall);
    push("gpu", data.gpu && data.gpu.utilization);
    push("mem", data.memory && data.memory.percent);
    push("rx", data.network && data.network.rx_per_sec);
    push("tx", data.network && data.network.tx_per_sec);
    push("total", data.network && (Number(data.network.rx_bytes || 0) + Number(data.network.tx_bytes || 0)));
    push("rxTcp", data.network && data.network.protocols && data.network.protocols.tcp && data.network.protocols.tcp.rx_per_sec);
    push("rxUdp", data.network && data.network.protocols && data.network.protocols.udp && data.network.protocols.udp.rx_per_sec);
    push("rxIcmp", data.network && data.network.protocols && data.network.protocols.icmp && data.network.protocols.icmp.rx_per_sec);
    push("rxIcmp6", data.network && data.network.protocols && data.network.protocols.icmp6 && data.network.protocols.icmp6.rx_per_sec);
    push("rxOther", data.network && data.network.protocols && data.network.protocols.other && data.network.protocols.other.rx_per_sec);
    push("txTcp", data.network && data.network.protocols && data.network.protocols.tcp && data.network.protocols.tcp.tx_per_sec);
    push("txUdp", data.network && data.network.protocols && data.network.protocols.udp && data.network.protocols.udp.tx_per_sec);
    push("txIcmp", data.network && data.network.protocols && data.network.protocols.icmp && data.network.protocols.icmp.tx_per_sec);
    push("txIcmp6", data.network && data.network.protocols && data.network.protocols.icmp6 && data.network.protocols.icmp6.tx_per_sec);
    push("txOther", data.network && data.network.protocols && data.network.protocols.other && data.network.protocols.other.tx_per_sec);
    push("temp", data.thermal && data.thermal.max);
    push("tempAvg", data.thermal && data.thermal.avg);
  }

  // ------------------------------------------------------------------------
  // live UI helpers
  // ------------------------------------------------------------------------

  function updateLivePill() {
    const pill = document.getElementById("live-pill");
    if (!pill) return;
    const text = document.getElementById("live-text");
    pill.classList.remove("online", "offline", "warn");
    if (state.nodeError) {
      pill.classList.add("offline");
      if (text) text.textContent = "Node offline";
    } else if (!state.socketConnected && !state.fallbackActive) {
      pill.classList.add("warn");
      if (text) text.textContent = "Reconnecting";
    } else {
      pill.classList.add("online");
      if (text) text.textContent = `Live · ${state.settings.refresh_ms}ms`;
    }
    const latency = document.getElementById("latency");
    if (latency) latency.textContent = state.latency != null ? `${Math.round(state.latency)}ms` : "";
  }

  function updateHeaderStatus() {
    const pill = document.getElementById("node-status-pill");
    if (!pill) return;
    const node = getNode(state.currentNodeId) || state.currentNode;
    const status = state.nodeError ? "offline" : node ? statusClass(node.last_status) : "unknown";
    pill.className = `badge ${status === "online" ? "ok" : status === "offline" ? "danger" : "warn"}`;
    pill.innerHTML = `<span class="node-dot ${status}"></span>${status}`;
    const last = document.getElementById("node-last-update");
    if (last) {
      if (state.nodeError) last.textContent = `Unreachable · ${state.nodeError}`;
      else if (state.lastSnapshotAt) last.textContent = `Updated ${timeAgo(new Date(state.lastSnapshotAt).toISOString())}`;
      else last.textContent = "Waiting for data…";
    }
  }

  function showNodeError(message) {
    const banner = document.getElementById("node-error-banner");
    if (!banner) return;
    banner.classList.remove("hidden");
    setText("node-error-text", message);
  }

  function hideNodeError() {
    const banner = document.getElementById("node-error-banner");
    if (banner) banner.classList.add("hidden");
  }

  function updateClock() {
    const text = fmtClock(new Date());
    $$(".clock").forEach((el) => { el.textContent = text; });
  }

  // ------------------------------------------------------------------------
  // node picker / sidebar
  // ------------------------------------------------------------------------

  function pickerNode() {
    return state.currentNode;
  }

  function renderNodePicker() {
    const node = pickerNode();
    if (!node) {
      if (!state.nodes.length) {
        return `<a class="node-picker-btn" href="/nodes" data-link><span class="node-dot unknown"></span><span class="node-picker-info"><span class="node-picker-name">No nodes yet</span><span class="node-picker-id">add a node</span></span>${icon("chevronDown", 15)}</a>`;
      }
      return `
        <button class="node-picker-btn" id="node-picker-btn" type="button">
          <span class="node-dot unknown"></span>
          <span class="node-picker-info">
            <span class="node-picker-name">Select a node</span>
            <span class="node-picker-id">${state.nodes.length} available</span>
          </span>
          <span class="node-picker-caret">${icon("chevronDown", 15)}</span>
        </button>`;
    }
    const status = statusClass(node.last_status);
    return `
      <button class="node-picker-btn" id="node-picker-btn" type="button">
        <span class="node-dot ${status}"></span>
        <span class="node-picker-info">
          <span class="node-picker-name">${escapeHtml(node.name)}</span>
          <span class="node-picker-id">${escapeHtml(node.id)}</span>
        </span>
        <span class="node-picker-caret">${icon("chevronDown", 15)}</span>
      </button>`;
  }

  function updateNodePicker() {
    const mount = document.getElementById("node-picker");
    if (!mount) return;
    mount.innerHTML = renderNodePicker();
    bindNodePicker();
  }

  function bindNodePicker() {
    const button = document.getElementById("node-picker-btn");
    if (!button) return;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNodeMenu(button);
    });
  }

  function toggleNodeMenu(button) {
    const existing = document.getElementById("node-menu");
    if (existing) {
      existing.remove();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "node-menu";
    menu.id = "node-menu";
    const active = state.currentNodeId || state.lastNodeId;
    menu.innerHTML = `<div class="node-menu-head">Switch node</div>` + state.nodes.map((node) => `
      <a class="node-menu-item ${node.id === active ? "active" : ""}" href="/node/${encodeURIComponent(node.id)}/usages" data-link>
        <span class="node-dot ${statusClass(node.last_status)}"></span>
        <span class="nm-name">${escapeHtml(node.name)}</span>
        <span class="nm-id">${escapeHtml(node.id)}</span>
      </a>`).join("") + `<a class="node-menu-link" href="/nodes" data-link>Manage all nodes →</a>`;
    button.parentElement.appendChild(menu);
    const close = (event) => {
      if (!menu.contains(event.target) && event.target !== button) {
        menu.remove();
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  function renderShell({ active = "", node = null, viewLabel = "", showLive = false, sidebar = true }) {
    const app = document.getElementById("app");
    app.className = `app ${state.collapsed ? "sidebar-collapsed" : ""}${sidebar ? "" : " no-sidebar"}`;
    const isMobile = window.matchMedia("(max-width: 900px)").matches;
    const menuLabel = isMobile ? "Menu" : (state.collapsed ? "Expand sidebar" : "Collapse sidebar");
    const menuExpanded = isMobile ? false : !state.collapsed;
    const id = node ? node.id : null;
    const nav = (key, href, label, iconName, badge = "") => `
      <a class="nav-item ${active === key ? "active" : ""}" href="${href}" data-link>
        <span class="ico">${icon(iconName, 17)}</span>
        <span class="txt">${label}</span>
        ${badge ? `<span class="nav-badge">${badge}</span>` : ""}
      </a>`;
    const navNode = node;
    const nodeLink = (view) => navNode ? `/node/${encodeURIComponent(navNode.id)}/${view}` : "/nodes";
    const crumb = node
      ? `<span class="crumb-node">${escapeHtml(node.name)}</span><span class="crumb-sep">/</span><span class="crumb-view">${escapeHtml(viewLabel)}</span>`
      : `<span class="crumb-node">Global</span><span class="crumb-sep">/</span><span class="crumb-view">${escapeHtml(viewLabel)}</span>`;

    const sidebarHtml = sidebar ? `
      <div class="sidebar-overlay" id="sidebar-overlay"></div>
      <aside class="sidebar ${state.collapsed ? "collapsed" : ""}" id="sidebar">
        <div class="brand">
          <a class="brand-mark" href="/nodes" data-link aria-label="Universal Monitor">${icon("activity", 20)}</a>
          <div class="brand-text">
            <div class="brand-name">Universal Monitor</div>
            <div class="brand-sub">Node control plane</div>
          </div>
        </div>
        <div class="node-picker" id="node-picker">${renderNodePicker()}</div>
        <nav class="nav">
          ${node ? `<div class="nav-section">Monitor</div>
          ${nav("usages", nodeLink("usages"), "Usages", "activity")}
          ${nav("temperature", nodeLink("temperature"), "Temperature", "thermometer")}
          ${nav("controls", nodeLink("controls"), "Controls", "power")}
          ${nav("terminal", nodeLink("terminal"), "Terminal", "terminal")}
          ${nav("btop", nodeLink("btop"), "BTOP++", "activity")}` : ""}
          <div class="nav-section">Global</div>
          ${nav("settings", "/settings", "Settings", "sliders")}
          ${nav("theme", "/theme", "Theme", "palette")}
          ${nav("nodes", "/nodes", "Nodes", "server", String(state.nodes.length))}
        </nav>
        <div class="sidebar-foot">
          <span class="live-mini"></span>
          <div class="foot-text"><strong>Universal Monitor</strong><br>v${escapeHtml(BOOT.version || "1.0.0")} · live websocket</div>
        </div>
      </aside>` : "";

    app.innerHTML = `${sidebarHtml}
      <div class="main">
        <header class="topbar">
          <button class="top-btn mobile-menu" id="mobile-menu" type="button" aria-label="${menuLabel}" title="${menuLabel}" aria-expanded="${menuExpanded ? "true" : "false"}">${icon("sidebarToggle", 18)}</button>
          <div class="crumb">${crumb}</div>
          <div class="top-actions">
            ${showLive ? `<span class="live-pill" id="live-pill"><span class="dot"></span><span id="live-text">Live</span></span><span class="latency" id="latency"></span>` : `<span class="badge muted">Global</span>`}
            <span class="clock" id="clock">${fmtClock(new Date())}</span>
            <a class="top-btn" href="/theme" data-link title="Theme">${icon("palette", 17)}</a>
            <a class="top-btn" href="/settings" data-link title="Settings">${icon("sliders", 17)}</a>
          </div>
        </header>
        <main class="content" id="view"></main>
      </div>`;

    bindNodePicker();
    bindShell();
    app.classList.remove("app-loading");
    updateLivePill();
  }

  function bindShell() {
    const appEl = document.getElementById("app");
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    const mobile = document.getElementById("mobile-menu");
    const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
    const syncMenuButton = () => {
      if (!mobile) return;
      if (isMobile()) {
        const open = !!(sidebar && sidebar.classList.contains("open"));
        mobile.title = open ? "Close menu" : "Menu";
        mobile.setAttribute("aria-label", mobile.title);
        mobile.setAttribute("aria-expanded", open ? "true" : "false");
      } else {
        const title = state.collapsed ? "Expand sidebar" : "Collapse sidebar";
        mobile.title = title;
        mobile.setAttribute("aria-label", title);
        mobile.setAttribute("aria-expanded", state.collapsed ? "false" : "true");
      }
    };
    const closeMobile = () => {
      if (sidebar) sidebar.classList.remove("open");
      if (overlay) overlay.classList.remove("show");
      syncMenuButton();
    };
    if (mobile && sidebar) {
      mobile.addEventListener("click", () => {
        if (isMobile()) {
          sidebar.classList.toggle("open");
          if (overlay) overlay.classList.toggle("show", sidebar.classList.contains("open"));
        } else {
          state.collapsed = !state.collapsed;
          localStorage.setItem("um.sidebar.collapsed", state.collapsed ? "1" : "0");
          if (appEl) appEl.classList.toggle("sidebar-collapsed", state.collapsed);
          sidebar.classList.toggle("collapsed", state.collapsed);
        }
        syncMenuButton();
      });
    }
    if (overlay) overlay.addEventListener("click", closeMobile);
    syncMenuButton();
  }

  // ------------------------------------------------------------------------
  // routing
  // ------------------------------------------------------------------------

  function parseRoute() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "") return { name: "nodes" };
    if (path === "/nodes") return { name: "nodes" };
    if (path === "/settings") return { name: "settings" };
    if (path === "/theme") return { name: "theme" };
    if (path === "/usages") return { name: "usages" };
    const match = path.match(/^\/node\/([^/]+)(?:\/(usages|temperature|controls|terminal|btop))?$/);
    if (match) {
      return { name: match[2] || "usages", nodeId: decodeURIComponent(match[1]), isNode: true };
    }
    return { name: "notfound" };
  }

  async function renderRoute() {
    const seq = ++state.routeSeq;
    closeModal();
    const route = parseRoute();

    if (route.name === "usages" && !route.isNode) {
      navigate("/nodes", true);
      return;
    }

    if (route.name === "notfound") {
      renderNotFound();
      return;
    }

    if (route.isNode) {
      const node = await ensureNode(route.nodeId);
      if (seq !== state.routeSeq) return;
      if (!node) {
        renderNotFound(`Node “${route.nodeId}” was not found.`);
        return;
      }
      if (state.currentNodeId !== node.id) {
        state.snapshot = null;
        state.nodeError = null;
        state.latency = null;
        state.lastSnapshotAt = 0;
        state.history = emptyHistory();
      }
      state.currentNode = node;
      state.view = null;
      if (route.name === "usages") renderUsagesPage(node);
      else if (route.name === "temperature") renderTemperaturePage(node);
      else if (route.name === "controls") renderControlsPage(node);
      else if (route.name === "terminal") renderTerminalPage(node);
      else if (route.name === "btop") renderBtopPage(node);
      if (seq === state.routeSeq) subscribeNode(node.id);
      return;
    }

    unsubscribeNode();
    state.view = null;
    if (route.name === "nodes") {
      state.currentNode = null;
      await renderNodesPage();
    } else if (route.name === "settings") {
      state.currentNode = null;
      await renderSettingsPage();
    } else if (route.name === "theme") {
      state.currentNode = null;
      await renderThemePage();
    }
  }

  function navigate(path, replace = false) {
    if (replace) history.replaceState({}, "", path);
    else history.pushState({}, "", path);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    renderRoute();
  }

  function renderNotFound(message = "The page you requested does not exist.") {
    unsubscribeNode();
    state.currentNode = null;
    renderShell({ active: "", viewLabel: "Not found", showLive: false });
    setHtml("view", `
      <div class="page-head">
        <div>
          <div class="page-title-row"><h1 class="page-title">Not found</h1><span class="badge warn">404</span></div>
          <p class="page-sub">${escapeHtml(message)}</p>
        </div>
      </div>
      <div class="empty">
        <div class="empty-icon">${icon("alert", 26)}</div>
        <div class="empty-title">Nothing to monitor here</div>
        <div class="empty-text">Head back to the node list to pick a machine.</div>
        <a class="btn btn-primary" href="/nodes" data-link>${icon("server", 16)} Go to nodes</a>
      </div>`);
  }

  function bindLinks() {
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest("a[data-link]");
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("#")) return;
      event.preventDefault();
      navigate(href);
    });
    window.addEventListener("popstate", renderRoute);
  }

  // ------------------------------------------------------------------------
  // nodes page
  // ------------------------------------------------------------------------

  async function renderNodesPage() {
    await loadNodes(true);
    const online = state.nodes.filter((n) => n.last_status === "online").length;
    const offline = state.nodes.filter((n) => n.last_status === "offline").length;
    renderShell({ active: "nodes", node: null, viewLabel: "Nodes", showLive: false, sidebar: false });

    const cards = state.nodes.map(nodeCardHtml).join("");
    const empty = `
      <div class="empty" style="grid-column:1/-1">
        <div class="empty-icon">${icon("server", 26)}</div>
        <div class="empty-title">No nodes connected yet</div>
        <div class="empty-text">Add your first machine with its address and API key. The agent exposes a small HTTP API that this control plane polls.</div>
        <button class="btn btn-primary" type="button" data-add-node>${icon("plus", 16)} Add your first node</button>
      </div>`;

    setHtml("view", `
      <div class="page-head">
        <div>
          <div class="page-title-row"><h1 class="page-title">Nodes</h1><span class="badge muted">control plane</span></div>
          <p class="page-sub">Every machine you monitor, in one place. Add a node with its agent address and API key. Agent timeout is ${state.settings.node_timeout_ms}ms.</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" id="refresh-nodes">${icon("refresh", 16)} Refresh</button>
          <button class="btn btn-primary" type="button" data-add-node>${icon("plus", 16)} Add node</button>
        </div>
      </div>

      <div class="nodes-stats">
        <div class="stat"><div class="stat-value">${state.nodes.length}</div><div class="stat-label">Total nodes</div></div>
        <div class="stat ok"><div class="stat-value">${online}</div><div class="stat-label">Online</div></div>
        <div class="stat danger"><div class="stat-value">${offline}</div><div class="stat-label">Offline</div></div>
      </div>

      <div class="node-grid" id="node-grid">
        ${cards || empty}
        ${state.nodes.length ? `<button class="node-card add-card" type="button" data-add-node>
          <span class="add-card-icon">${icon("plus", 24)}</span>
          <span class="add-card-title">Add another node</span>
          <span class="add-card-sub">Connect a machine running um-node.py</span>
        </button>` : ""}
      </div>

      <section class="card" style="margin-top:20px">
        <div class="card-body" style="display:flex;align-items:flex-start;gap:14px">
          <div class="empty-icon" style="margin:0;flex:0 0 auto">${icon("shield", 22)}</div>
          <div>
            <h3 class="card-title">How nodes connect</h3>
            <p class="page-sub" style="margin-top:6px">Run <code>python3 um-node.py run</code> on the target machine, then add the printed address and API key here. The agent picks a free port automatically and stores its config in <code>nodes/</code>.</p>
          </div>
        </div>
      </section>`);

    const add = () => openNodeForm();
    $$("[data-add-node]").forEach((btn) => btn.addEventListener("click", add));
    const refresh = document.getElementById("refresh-nodes");
    if (refresh) {
      refresh.addEventListener("click", async () => {
        setButtonLoading(refresh, "Refreshing…");
        await loadNodes(true);
        restoreButton(refresh);
        renderNodesPage();
      });
    }
    bindNodeCards();
  }

  function nodeCardHtml(node) {
    const status = statusClass(node.last_status);
    const online = status === "online";
    return `
      <article class="node-card" data-node-id="${escapeHtml(node.id)}">
        <div class="node-card-top">
          <div class="node-card-avatar">${icon("server", 18)}</div>
          <div style="min-width:0;flex:1">
            <div class="node-card-name">
              <a href="/node/${encodeURIComponent(node.id)}/usages" data-link>${escapeHtml(node.name)}</a>
            </div>
            <div class="node-card-id">${escapeHtml(node.id)}</div>
          </div>
          <span class="status-pill ${status}" data-role="status"><span class="dot"></span>${status}</span>
        </div>
        <div class="node-card-desc">${escapeHtml(node.description || "No description")}</div>
        <div class="node-card-address" title="${escapeHtml(node.address)}">${icon("wifi", 13)} ${escapeHtml(shortAddress(node.address))}</div>
        <div class="node-card-foot">
          <span class="node-latency" data-role="latency">${node.last_latency_ms != null ? `${Math.round(node.last_latency_ms)}ms` : "—"}</span>
          <span class="node-card-seen muted tiny" data-role="seen">${online ? `Seen ${timeAgo(node.last_seen)}` : (node.last_error ? escapeHtml(node.last_error) : "Never seen")}</span>
          <div class="node-card-actions">
            <button class="icon-action" type="button" data-node-action="check" title="Check now">${icon("refresh", 15)}</button>
            <button class="icon-action" type="button" data-node-action="edit" title="Edit node">${icon("pencil", 15)}</button>
            <button class="icon-action danger" type="button" data-node-action="delete" title="Delete node">${icon("trash", 15)}</button>
          </div>
        </div>
      </article>`;
  }

  function bindNodeCards() {
    const grid = document.getElementById("node-grid");
    if (!grid) return;
    grid.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("[data-node-action]");
      if (actionBtn) {
        event.preventDefault();
        event.stopPropagation();
        const card = actionBtn.closest("[data-node-id]");
        const node = getNode(card.dataset.nodeId);
        if (!node) return;
        const action = actionBtn.dataset.nodeAction;
        if (action === "edit") openNodeForm(node);
        else if (action === "delete") confirmDeleteNode(node);
        else if (action === "check") checkNode(node, actionBtn);
        return;
      }
      const card = event.target.closest(".node-card[data-node-id]");
      if (card && !event.target.closest("a")) {
        navigate(`/node/${encodeURIComponent(card.dataset.nodeId)}/usages`);
      }
    });
  }

  async function checkNode(node, button) {
    setButtonLoading(button, "");
    try {
      const data = await api(`/api/nodes/${encodeURIComponent(node.id)}/check`, { method: "POST" });
      const status = data.status || {};
      node.last_status = status.status || "unknown";
      node.last_latency_ms = status.latency_ms;
      node.last_error = status.error;
      if (status.status === "online") node.last_seen = new Date().toISOString();
      updateNodeCard(node);
      updateNodeStatuses([{ ...node, id: node.id }]);
      toast(status.status === "online" ? `${node.name} is online (${Math.round(status.latency_ms || 0)}ms)` : `${node.name} is offline`, status.status === "online" ? "ok" : "error");
    } catch (error) {
      toast(error.message, "error");
    }
    restoreButton(button);
  }

  function updateNodeCard(node) {
    const card = document.querySelector(`.node-card[data-node-id="${CSS.escape(node.id)}"]`);
    if (!card) return;
    const status = statusClass(node.last_status);
    const statusEl = card.querySelector('[data-role="status"]');
    if (statusEl) {
      statusEl.className = `status-pill ${status}`;
      statusEl.innerHTML = `<span class="dot"></span>${status}`;
    }
    const latency = card.querySelector('[data-role="latency"]');
    if (latency) latency.textContent = node.last_latency_ms != null ? `${Math.round(node.last_latency_ms)}ms` : "—";
    const seen = card.querySelector('[data-role="seen"]');
    if (seen) seen.textContent = status === "online" ? `Seen ${timeAgo(node.last_seen)}` : (node.last_error || "Never seen");
  }

  function updateNodeStatuses(statuses) {
    let changed = false;
    statuses.forEach((incoming) => {
      const node = getNode(incoming.id || incoming.node_id);
      if (!node) return;
      if (incoming.status) node.last_status = incoming.status;
      if (incoming.last_status) node.last_status = incoming.last_status;
      if (incoming.latency_ms !== undefined) node.last_latency_ms = incoming.latency_ms;
      if (incoming.last_latency_ms !== undefined) node.last_latency_ms = incoming.last_latency_ms;
      if (incoming.last_error !== undefined) node.last_error = incoming.last_error;
      if (incoming.error !== undefined) node.last_error = incoming.error;
      if (incoming.last_seen !== undefined) node.last_seen = incoming.last_seen;
      if (node.last_status === "online" && !node.last_seen) node.last_seen = new Date().toISOString();
      changed = true;
      updateNodeCard(node);
      if (node.id === state.currentNodeId) updateHeaderStatus();
    });
    if (changed) {
      updateNodePicker();
      const total = document.getElementById("node-total");
      if (total) total.textContent = state.nodes.length;
    }
  }

  // ------------------------------------------------------------------------
  // node form / delete
  // ------------------------------------------------------------------------

  function openNodeForm(node = null) {
    const editing = !!node;
    const html = `
      <div class="modal-head">
        <div class="modal-icon">${icon(editing ? "pencil" : "plus", 20)}</div>
        <div style="flex:1">
          <h2 class="modal-title">${editing ? escapeHtml(node.name) : "Connect a machine"}</h2>
          <p class="modal-sub">${editing ? "Update the agent address or rotate its API key." : "Enter the address and API key printed by the node agent."}</p>
        </div>
        <button class="modal-close" type="button" data-close aria-label="Close">${icon("x", 16)}</button>
      </div>
      <form id="node-form" class="modal-body">
        <div class="form-grid">
          <div class="form-row">
            <label class="field">
              <span class="tiny">Name</span>
              <input class="input" name="name" value="${editing ? escapeHtml(node.name) : ""}" placeholder="e.g. Home VPS" maxlength="80" required autofocus>
            </label>
            <label class="field">
              <span class="tiny">Description · optional</span>
              <input class="input" name="description" value="${editing ? escapeHtml(node.description || "") : ""}" placeholder="What runs here?" maxlength="500">
            </label>
          </div>
          <label class="field">
            <span class="tiny">Agent address</span>
            <input class="input mono" name="address" value="${editing ? escapeHtml(node.address) : ""}" placeholder="localhost:8788 or http://192.168.0.180:8788" required>
            <span class="hint">The host and port printed when <code>um-node.py run</code> starts.</span>
          </label>
          <label class="field">
            <span class="tiny">API key</span>
            <input class="input mono" name="api_key" value="${editing ? escapeHtml(node.api_key || "") : ""}" placeholder="${editing ? "Current key shown above" : "umk_…"}" ${editing ? "" : "required"} autocomplete="off" spellcheck="false">
            <span class="hint">${editing ? "The current key is shown; edit it to rotate, or leave it unchanged." : "Copy the key printed by the agent. It is stored on this server only."}</span>
          </label>
          <div class="field-error hidden" id="node-form-error"></div>
          <div class="modal-foot" style="padding:0">
            <button class="btn btn-ghost" type="button" data-close>Cancel</button>
            <button class="btn btn-primary" type="submit" id="node-form-submit">${icon(editing ? "save" : "plus", 16)} ${editing ? "Save changes" : "Verify & add node"}</button>
          </div>
        </div>
      </form>`;

    const wrap = openModal(html);
    const form = document.getElementById("node-form");
    const errorBox = document.getElementById("node-form-error");
    const submit = document.getElementById("node-form-submit");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.classList.add("hidden");
      const data = Object.fromEntries(new FormData(form).entries());
      data.name = String(data.name || "").trim();
      data.address = String(data.address || "").trim();
      data.api_key = String(data.api_key || "").trim();
      data.description = String(data.description || "").trim();
      if (!data.name || !data.address || (!editing && !data.api_key)) {
        errorBox.textContent = "Name, address and API key are required.";
        errorBox.classList.remove("hidden");
        return;
      }
      setButtonLoading(submit, editing ? "Saving…" : "Verifying…");
      try {
        const response = editing
          ? await api(`/api/nodes/${encodeURIComponent(node.id)}`, { method: "PUT", body: JSON.stringify(data) })
          : await api("/api/nodes", { method: "POST", body: JSON.stringify(data) });
        const saved = response.node;
        await loadNodes(true);
        closeModal();
        toast(editing ? `${saved.name} updated` : `${saved.name} connected`, "ok");
        if (editing) {
          renderNodesPage();
        } else {
          navigate(`/node/${encodeURIComponent(saved.id)}/usages`);
        }
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.classList.remove("hidden");
        restoreButton(submit);
      }
    });
    setTimeout(() => {
      const first = form.querySelector("input[name=name]");
      if (first) first.focus();
    }, 30);
    return wrap;
  }

  function confirmDeleteNode(node) {
    const html = `
      <div class="modal-head">
        <div class="modal-icon danger">${icon("trash", 20)}</div>
        <div style="flex:1">
          <h2 class="modal-title">Delete ${escapeHtml(node.name)}?</h2>
          <p class="modal-sub">This removes the node and its API key from this control plane. The agent keeps running on the machine.</p>
        </div>
        <button class="modal-close" type="button" data-close aria-label="Close">${icon("x", 16)}</button>
      </div>
      <div class="modal-body">
        <div class="danger-box">
          <div style="display:flex;align-items:flex-start;gap:9px">
            <span style="color:#fca5a5;margin-top:1px">${icon("alert", 18)}</span>
            <div>To confirm, type the node ID <code>${escapeHtml(node.id)}</code> below.</div>
          </div>
        </div>
        <form id="delete-form" class="form-grid">
          <label class="field">
            <span class="tiny">Node ID</span>
            <input class="input mono" name="confirm_id" placeholder="${escapeHtml(node.id)}" autocomplete="off" spellcheck="false" required>
          </label>
          <div class="field-error hidden" id="delete-error"></div>
          <div class="modal-foot" style="padding:0">
            <button class="btn btn-ghost" type="button" data-close>Cancel</button>
            <button class="btn btn-danger" type="submit" id="delete-submit">${icon("trash", 16)} Delete node</button>
          </div>
        </form>
      </div>`;
    openModal(html);
    const form = document.getElementById("delete-form");
    const errorBox = document.getElementById("delete-error");
    const submit = document.getElementById("delete-submit");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = String(new FormData(form).get("confirm_id") || "").trim();
      if (value !== node.id) {
        errorBox.textContent = "That does not match the node ID.";
        errorBox.classList.remove("hidden");
        return;
      }
      setButtonLoading(submit, "Deleting…");
      try {
        await api(`/api/nodes/${encodeURIComponent(node.id)}`, { method: "DELETE" });
        await loadNodes(true);
        closeModal();
        toast(`${node.name} removed`, "ok");
        if (state.currentNodeId === node.id) navigate("/nodes");
        else renderNodesPage();
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.classList.remove("hidden");
        restoreButton(submit);
      }
    });
  }

  // ------------------------------------------------------------------------
  // shared node page bits
  // ------------------------------------------------------------------------

  function nodePageHead(node, viewLabel, sub, actions = "") {
    return `
      <div class="page-head">
        <div>
          <div class="page-title-row">
            <h1 class="page-title">${escapeHtml(node.name)}</h1>
            <span class="badge" id="node-status-pill"><span class="node-dot unknown"></span>unknown</span>
            <span class="id-chip">${escapeHtml(node.id)}</span>
          </div>
          <p class="page-sub">${sub}</p>
        </div>
        <div class="page-actions">${actions}</div>
      </div>`;
  }

  function nodeErrorBanner() {
    return `
      <div class="banner danger hidden" id="node-error-banner">
        <div class="banner-icon">${icon("alert", 18)}</div>
        <div class="banner-text">
          <strong>Agent unreachable</strong>
          <div class="banner-sub" id="node-error-text"></div>
        </div>
        <button class="btn btn-sm" type="button" id="retry-node">${icon("refresh", 14)} Retry</button>
      </div>`;
  }

  function nodeActions(node, active) {
    const id = encodeURIComponent(node.id);
    const link = (key, href, label, iconName) => `<a class="btn ${active === key ? "btn-primary" : ""}" href="${href}" data-link>${icon(iconName, 15)} ${label}</a>`;
    return [
      link("usages", `/node/${id}/usages`, "Usages", "activity"),
      link("temperature", `/node/${id}/temperature`, "Temperature", "thermometer"),
      link("controls", `/node/${id}/controls`, "Controls", "power"),
      link("terminal", `/node/${id}/terminal`, "Terminal", "terminal"),
      link("btop", `/node/${id}/btop`, "BTOP++", "activity"),
    ].join("");
  }

  function bindNodePageCommon(node) {
    const retry = document.getElementById("retry-node");
    if (retry) {
      retry.addEventListener("click", async () => {
        setButtonLoading(retry, "Retrying…");
        try {
          const data = await api(`/api/nodes/${encodeURIComponent(node.id)}/snapshot`);
          handleSnapshot({ node_id: node.id, data: data.data, latency_ms: data.latency_ms, received_at: data.received_at });
          toast("Snapshot refreshed", "ok");
        } catch (error) {
          handleNodeError(error.message);
        }
        restoreButton(retry);
      });
    }
    updateHeaderStatus();
  }

  function renderCurrentView() {
    if (state.snapshot && state.view && state.view.update) state.view.update(state.snapshot);
    updateHeaderStatus();
    updateLivePill();
  }

  // ------------------------------------------------------------------------
  // usages
  // ------------------------------------------------------------------------

  function renderUsagesPage(node) {
    renderShell({ active: "usages", node, viewLabel: "Usages", showLive: true });
    setHtml("view", `
      ${nodeErrorBanner()}
      ${nodePageHead(node, "Usages", `Live usage for <span class="mono">${escapeHtml(shortAddress(node.address))}</span> · refreshing every ${state.settings.refresh_ms}ms`, nodeActions(node, "usages"))}

      <div class="kpi-grid">
        <div class="kpi accent">
          <div class="kpi-top"><span class="kpi-label">CPU</span><span class="kpi-icon">${icon("cpu", 17)}</span></div>
          <div class="kpi-value"><span id="kpi-cpu">—</span><span class="kpi-unit">%</span></div>
          <div class="kpi-sub" id="kpi-cpu-sub">waiting for data…</div>
          <div class="kpi-spark"><canvas id="spark-cpu"></canvas></div>
        </div>
        <div class="kpi">
          <div class="kpi-top"><span class="kpi-label">GPU</span><span class="kpi-icon">${icon("gpu", 17)}</span></div>
          <div class="kpi-value"><span id="kpi-gpu">—</span><span class="kpi-unit">%</span></div>
          <div class="kpi-sub" id="kpi-gpu-sub">waiting for data…</div>
          <div class="kpi-spark"><canvas id="spark-gpu"></canvas></div>
        </div>
        <div class="kpi ok">
          <div class="kpi-top"><span class="kpi-label">Memory</span><span class="kpi-icon">${icon("memory", 17)}</span></div>
          <div class="kpi-value"><span id="kpi-mem">—</span><span class="kpi-unit">%</span></div>
          <div class="kpi-sub" id="kpi-mem-sub">waiting for data…</div>
          <div class="kpi-spark"><canvas id="spark-mem"></canvas></div>
        </div>
        <div class="kpi">
          <div class="kpi-top"><span class="kpi-label">Network</span><span class="kpi-icon">${icon("network", 17)}</span></div>
          <div class="kpi-value"><span id="kpi-net-down">—</span></div>
          <div class="kpi-sub" id="kpi-net-up">upload —</div>
          <div class="kpi-spark"><canvas id="spark-net"></canvas></div>
        </div>
        <div class="kpi">
          <div class="kpi-top"><span class="kpi-label">Data transferred</span><span class="kpi-icon">${icon("network", 17)}</span></div>
          <div class="kpi-value"><span id="kpi-data-down">—</span></div>
          <div class="kpi-sub" id="kpi-data-up">upload — · since boot</div>
          <div class="kpi-spark"><canvas id="spark-data"></canvas></div>
        </div>
        <div class="kpi">
          <div class="kpi-top"><span class="kpi-label">Uptime</span><span class="kpi-icon">${icon("clock", 17)}</span></div>
          <div class="kpi-value"><span id="kpi-uptime">—</span></div>
          <div class="kpi-sub" id="kpi-uptime-sub">since boot</div>
          <div class="kpi-spark"><canvas id="spark-uptime"></canvas></div>
        </div>
      </div>

      <div class="chart-grid">
        <section class="card chart-card">
          <div class="chart-head">
            <div><div class="chart-title">CPU load</div><div class="chart-value" id="chart-cpu-value">—</div></div>
          </div>
          <div class="chart-canvas-wrap"><canvas id="chart-cpu"></canvas></div>
          <div class="chart-legend">
            <span><span class="legend-dot" style="background:var(--accent)"></span>CPU</span>
            <span class="muted">last ${state.settings.history_points} samples</span>
          </div>
        </section>
        <section class="card chart-card">
          <div class="chart-head">
            <div><div class="chart-title">GPU load</div><div class="chart-value" id="chart-gpu-value">—</div></div>
          </div>
          <div class="chart-canvas-wrap"><canvas id="chart-gpu"></canvas></div>
          <div class="chart-legend">
            <span><span class="legend-dot" style="background:var(--accent-2)"></span>GPU</span>
            <span class="muted" id="chart-gpu-detail">—</span>
          </div>
        </section>
      </div>

      <div class="chart-grid">
        <section class="card chart-card">
          <div class="chart-head">
            <div><div class="chart-title">Memory usage</div><div class="chart-value" id="chart-mem-value">—</div></div>
          </div>
          <div class="chart-canvas-wrap"><canvas id="chart-mem"></canvas></div>
          <div class="chart-legend">
            <span><span class="legend-dot" style="background:var(--ok)"></span>RAM used</span>
            <span class="muted" id="chart-mem-detail">—</span>
          </div>
        </section>
        <section class="card chart-card">
          <div class="chart-head">
            <div><div class="chart-title">Data transferred</div><div class="chart-value" id="chart-data-value">—</div></div>
          </div>
          <div class="card-body" style="padding-top:10px">
            <div class="data-totals">
              <div><div class="info-label">Downloaded</div><div class="data-total" id="data-total-down">—</div><div class="muted tiny">since boot</div></div>
              <div><div class="info-label">Uploaded</div><div class="data-total" id="data-total-up">—</div><div class="muted tiny">since boot</div></div>
            </div>
          </div>
        </section>
      </div>

      <div class="chart-grid">
        <section class="card chart-card">
          <div class="chart-head">
            <div><div class="chart-title">Download · protocols</div><div class="chart-value" id="chart-net-down-value">—</div></div>
          </div>
          <div class="chart-canvas-wrap"><canvas id="chart-net-down"></canvas></div>
          <div class="chart-legend">
            <span><span class="legend-dot" style="background:var(--accent-2)"></span>TCP</span>
            <span><span class="legend-dot" style="background:var(--warn)"></span>UDP</span>
            <span><span class="legend-dot" style="background:var(--danger)"></span>ICMP</span>
            <span><span class="legend-dot" style="background:var(--ok)"></span>ICMPv6</span>
            <span><span class="legend-dot" style="background:var(--faint)"></span>Other</span>
          </div>
        </section>
        <section class="card chart-card">
          <div class="chart-head">
            <div><div class="chart-title">Upload · protocols</div><div class="chart-value" id="chart-net-up-value">—</div></div>
          </div>
          <div class="chart-canvas-wrap"><canvas id="chart-net-up"></canvas></div>
          <div class="chart-legend">
            <span><span class="legend-dot" style="background:var(--accent-2)"></span>TCP</span>
            <span><span class="legend-dot" style="background:var(--warn)"></span>UDP</span>
            <span><span class="legend-dot" style="background:var(--danger)"></span>ICMP</span>
            <span><span class="legend-dot" style="background:var(--ok)"></span>ICMPv6</span>
            <span><span class="legend-dot" style="background:var(--faint)"></span>Other</span>
          </div>
        </section>
      </div>

      <div class="split-grid">
        <div class="split-col">
          <section class="card">
            <div class="card-head">
              <div><h3 class="card-title">System</h3><div class="card-sub">Identity reported by the agent</div></div>
              <div class="card-actions"><span class="badge muted" id="sys-agent-badge">agent</span></div>
            </div>
            <div class="card-body"><div class="info-grid" id="sys-info">${systemInfoSkeleton()}</div></div>
          </section>
          <section class="card">
            <div class="card-head">
              <div><h3 class="card-title">CPU cores</h3><div class="card-sub" id="core-sub">Per-core utilization</div></div>
              <div class="card-actions"><span class="badge muted" id="core-count-badge">—</span></div>
            </div>
            <div class="card-body"><div class="core-grid" id="core-grid"><div class="muted tiny">waiting for data…</div></div></div>
          </section>
        </div>
        <div class="split-col">
          <section class="card">
            <div class="card-head">
              <div><h3 class="card-title">Disks</h3><div class="card-sub" id="disk-sub">Mounted filesystems</div></div>
            </div>
            <div class="card-body"><div class="disk-list" id="disk-list"><div class="muted tiny">waiting for data…</div></div></div>
          </section>
        </div>
      </div>`);

    bindNodePageCommon(node);
    state.view = {
      update: updateUsages,
      redraw: () => { if (state.snapshot && state.view && state.view.update) state.view.update(state.snapshot); },
      error: (message) => showNodeError(message),
      settingsChanged: () => {
        const sub = document.querySelector(".page-sub");
        if (sub) sub.innerHTML = `Live usage for <span class="mono">${escapeHtml(shortAddress(node.address))}</span> · refreshing every ${state.settings.refresh_ms}ms`;
      },
    };
    renderCurrentView();
  }

  function systemInfoSkeleton() {
    const items = [
      ["hostname", "Hostname"], ["device", "Machine"], ["device_type", "Machine type"],
      ["device_vendor", "Vendor"], ["machine", "Architecture"], ["gpu", "GPU"],
      ["kernel", "Kernel"], ["cpu", "CPU model"], ["uptime", "Uptime"],
      ["agent", "Agent"], ["cwd", "Terminal cwd"], ["address", "Address"],
    ];
    return items.map(([key, label]) => `<div class="info-item"><div class="info-label">${label}</div><div class="info-value" id="sys-${key}">—</div></div>`).join("");
  }

  function updateUsages(data) {
    if (!document.getElementById("kpi-cpu")) return;
    const cpu = data.cpu || {};
    const mem = data.memory || {};
    const gpu = data.gpu || {};
    const net = data.network || {};
    const nodeInfo = data.node || {};
    const h = state.history;

    const cpuPct = Number(cpu.overall) || 0;
    setText("kpi-cpu", cpuPct.toFixed(0));
    setText("kpi-cpu-sub", `${cpu.logical_cores || 0} threads · load ${(cpu.load || []).map((v) => Number(v).toFixed(2)).join(" / ")}`);
    setKpiTone("kpi-cpu", cpuPct);

    const gpuPct = gpu.utilization == null ? null : Number(gpu.utilization);
    const gpuName = gpu.name && !/not detected|does not exist|not found|none/i.test(gpu.name)
      ? gpu.name
      : "GPU does not exist";
    setText("kpi-gpu", gpuPct == null ? "N/A" : gpuPct.toFixed(0));
    setText("kpi-gpu-sub", `${gpuName}${gpu.users != null ? ` · ${gpu.users} client(s)` : ""}`);
    if (gpuPct != null) setKpiTone("kpi-gpu", gpuPct);

    const memPct = Number(mem.percent) || 0;
    setText("kpi-mem", memPct.toFixed(0));
    setText("kpi-mem-sub", `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)} · ${fmtBytes(mem.available)} available${mem.swap_total ? ` · swap ${Number(mem.swap_percent || 0).toFixed(0)}%` : ""}`);
    setKpiTone("kpi-mem", memPct);

    const totalRx = net.total_rx_bytes != null ? Number(net.total_rx_bytes) : Number(net.rx_bytes || 0);
    const totalTx = net.total_tx_bytes != null ? Number(net.total_tx_bytes) : Number(net.tx_bytes || 0);

    setText("kpi-net-down", `↓ ${fmtRate(net.rx_per_sec || 0)}`);
    setText("kpi-net-up", `↑ ${fmtRate(net.tx_per_sec || 0)}`);
    setText("kpi-data-down", `↓ ${fmtBytes(totalRx)}`);
    setText("kpi-data-up", `↑ ${fmtBytes(totalTx)} · since boot`);

    setText("kpi-uptime", fmtDuration(nodeInfo.uptime || 0));
    setText("kpi-uptime-sub", nodeInfo.started_at ? `agent since ${new Date(nodeInfo.started_at).toLocaleDateString()}` : "since boot");

    setText("chart-cpu-value", `${cpuPct.toFixed(0)}%`);
    setText("chart-gpu-value", gpuPct == null ? "N/A" : `${gpuPct.toFixed(0)}%`);
    setText("chart-gpu-detail", gpuName);
    setText("chart-mem-value", `${memPct.toFixed(0)}%`);
    setText("chart-mem-detail", `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)} · ${fmtBytes(mem.available)} available`);
    setText("chart-data-value", `↓ ${fmtBytes(totalRx)} · ↑ ${fmtBytes(totalTx)}`);
    setText("data-total-down", fmtBytes(totalRx));
    setText("data-total-up", fmtBytes(totalTx));
    setText("chart-net-down-value", `↓ ${fmtRate(net.rx_per_sec || 0)} · ${fmtBytes(totalRx)} total`);
    setText("chart-net-up-value", `↑ ${fmtRate(net.tx_per_sec || 0)} · ${fmtBytes(totalTx)} total`);

    const protocolColors = {
      tcp: cssVar("--accent-2"),
      udp: cssVar("--warn"),
      icmp: cssVar("--danger"),
      icmp6: cssVar("--ok"),
      other: cssVar("--faint"),
    };
    const protocolSeries = (prefix) => [
      { data: h[`${prefix}Tcp`], color: protocolColors.tcp, fill: true },
      { data: h[`${prefix}Udp`], color: protocolColors.udp, fill: false },
      { data: h[`${prefix}Icmp`], color: protocolColors.icmp, fill: false },
      { data: h[`${prefix}Icmp6`], color: protocolColors.icmp6, fill: false },
      { data: h[`${prefix}Other`], color: protocolColors.other, fill: false },
    ];

    drawSpark("spark-cpu", h.cpu, cssVar("--accent"), 100);
    drawSpark("spark-gpu", h.gpu, cssVar("--accent-2"), 100);
    drawSpark("spark-mem", h.mem, cssVar("--ok"), 100);
    drawSpark("spark-net", h.rx, cssVar("--accent-2"));
    drawSpark("spark-data", h.total, cssVar("--accent"));
    drawChart("chart-cpu", {
      series: [{ data: h.cpu, color: cssVar("--accent"), fill: true }],
      min: 0, max: 100, gridLines: [25, 50, 75], unit: "%",
    });
    drawChart("chart-gpu", {
      series: [{ data: h.gpu, color: cssVar("--accent-2"), fill: true }],
      min: 0, max: 100, gridLines: [25, 50, 75], unit: "%",
    });
    drawChart("chart-mem", {
      series: [{ data: h.mem, color: cssVar("--ok"), fill: true }],
      min: 0, max: 100, gridLines: [25, 50, 75], unit: "%",
    });
    drawChart("chart-net-down", {
      series: protocolSeries("rx"),
      min: 0, unit: "B/s",
    });
    drawChart("chart-net-up", {
      series: protocolSeries("tx"),
      min: 0, unit: "B/s",
    });

    updateSystemInfo(data, nodeInfo);
    updateCoreGrid(cpu.cores || [], cpu.logical_cores || 0);
    updateDisks(data.disks || []);
    updateHeaderStatus();
  }

  function setKpiTone(id, value, inverse = false, isTemp = false) {
    const card = document.getElementById(id);
    if (!card) return;
    const el = card.closest(".kpi");
    if (!el) return;
    el.classList.remove("ok", "warn", "danger");
    let level = "ok";
    if (isTemp) {
      const c = Number(value);
      level = c >= 80 ? "danger" : c >= 65 ? "warn" : "ok";
    } else {
      level = Number(value) >= 90 ? "danger" : Number(value) >= 70 ? "warn" : "ok";
    }
    if (inverse) level = "ok";
    el.classList.add(level);
  }

  function updateSystemInfo(data, nodeInfo) {
    const set = (key, value) => {
      const el = document.getElementById(`sys-${key}`);
      if (el) {
        el.textContent = value == null || value === "" ? "—" : String(value);
        el.title = el.textContent;
      }
    };
    const gpu = data.gpu || {};
    const gpuName = gpu.name && !/not detected|does not exist|not found|none/i.test(gpu.name)
      ? gpu.name
      : "GPU does not exist";
    set("hostname", nodeInfo.hostname);
    set("device", nodeInfo.device_model || nodeInfo.hostname || "Unknown");
    set("device_type", nodeInfo.device_type || "Unknown");
    set("device_vendor", nodeInfo.device_vendor || "Unknown");
    set("gpu", gpuName);
    set("kernel", nodeInfo.kernel);
    set("machine", nodeInfo.machine);
    set("cpu", nodeInfo.cpu_model);
    set("uptime", fmtDuration(nodeInfo.uptime));
    set("agent", `v${nodeInfo.version || "?"}`);
    set("cwd", shortCwd(nodeInfo.cwd));
    const node = getNode(state.currentNodeId);
    set("address", node ? shortAddress(node.address) : "");
    const badge = document.getElementById("sys-agent-badge");
    if (badge) badge.textContent = nodeInfo.version ? `agent v${nodeInfo.version}` : "agent";
  }

  function updateCoreGrid(cores, logical) {
    const grid = document.getElementById("core-grid");
    if (!grid) return;
    const badge = document.getElementById("core-count-badge");
    if (badge) badge.textContent = `${cores.length || logical || 0} cores`;
    const sub = document.getElementById("core-sub");
    if (sub) sub.textContent = `Per-core utilization · ${cores.length || logical || 0} logical processors`;
    if (!cores.length) {
      grid.innerHTML = `<div class="muted tiny">No per-core data reported.</div>`;
      return;
    }
    if (grid.children.length !== cores.length || !grid.querySelector(".core")) {
      grid.innerHTML = cores.map((_, index) => `
        <div class="core" data-core-index="${index}">
          <div class="core-top"><span class="core-name">CPU ${index}</span><span class="core-val" data-role="val">—</span></div>
          <div class="bar"><i data-role="fill" style="width:0%"></i></div>
        </div>`).join("");
    }
    cores.forEach((value, index) => {
      const row = grid.querySelector(`[data-core-index="${index}"]`);
      if (!row) return;
      const pct = Math.max(0, Math.min(100, Number(value) || 0));
      const fill = row.querySelector('[data-role="fill"]');
      const val = row.querySelector('[data-role="val"]');
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.className = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
      }
      if (val) val.textContent = `${pct.toFixed(0)}%`;
    });
  }

  function updateDisks(disks) {
    const list = document.getElementById("disk-list");
    if (!list) return;
    const sub = document.getElementById("disk-sub");
    if (sub) sub.textContent = disks.length ? `${disks.length} mounted filesystem${disks.length === 1 ? "" : "s"}` : "No disks reported";
    if (!disks.length) {
      list.innerHTML = `<div class="muted tiny">No mounted filesystems found.</div>`;
      return;
    }
    if (list.children.length !== disks.length || !list.querySelector(".disk-row")) {
      list.innerHTML = disks.map((disk, index) => `
        <div class="disk-row" data-disk-index="${index}">
          <div class="disk-top">
            <span class="disk-name" data-role="name">—</span>
            <span class="disk-meta" data-role="meta">—</span>
          </div>
          <div class="bar disk-bar"><i data-role="fill" style="width:0%"></i></div>
        </div>`).join("");
    }
    disks.forEach((disk, index) => {
      const row = list.querySelector(`[data-disk-index="${index}"]`);
      if (!row) return;
      const pct = Math.max(0, Math.min(100, Number(disk.percent) || 0));
      const name = row.querySelector('[data-role="name"]');
      const meta = row.querySelector('[data-role="meta"]');
      const fill = row.querySelector('[data-role="fill"]');
      if (name) {
        name.textContent = disk.mount;
        name.title = `${disk.device || ""} (${disk.fstype || "?"})`;
      }
      if (meta) meta.textContent = `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)} · ${fmtBytes(disk.free)} available · ${pct.toFixed(0)}%`;
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.className = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "";
      }
    });
  }

  // ------------------------------------------------------------------------
  // temperature
  // ------------------------------------------------------------------------

  function renderTemperaturePage(node) {
    renderShell({ active: "temperature", node, viewLabel: "Temperature", showLive: true });
    setHtml("view", `
      ${nodeErrorBanner()}
      ${nodePageHead(node, "Temperature", `Thermal zones reported by <span class="mono">${escapeHtml(shortAddress(node.address))}</span>`, nodeActions(node, "temperature"))}

      <div class="temp-hero">
        <div class="temp-stat">
          <div class="temp-stat-label">Hottest</div>
          <div class="temp-big" id="temp-max">—</div>
          <div class="temp-sub" id="temp-max-sub">waiting for data…</div>
        </div>
        <div class="temp-stat">
          <div class="temp-stat-label">Average</div>
          <div class="temp-big" id="temp-avg">—</div>
          <div class="temp-sub" id="temp-avg-sub">across all zones</div>
        </div>
        <div class="temp-stat">
          <div class="temp-stat-label">Coolest</div>
          <div class="temp-big" id="temp-min">—</div>
          <div class="temp-sub" id="temp-min-sub">waiting for data…</div>
        </div>
        <div class="temp-stat">
          <div class="temp-stat-label">Sensors</div>
          <div class="temp-big" id="temp-count">—</div>
          <div class="temp-sub">thermal zones</div>
        </div>
      </div>

      <section class="card chart-card" style="margin-bottom:20px">
        <div class="chart-head">
          <div><div class="chart-title">Temperature history</div><div class="chart-value" id="temp-chart-value">—</div></div>
        </div>
        <div class="chart-canvas-wrap"><canvas id="chart-temp"></canvas></div>
        <div class="chart-legend">
          <span><span class="legend-dot" style="background:var(--danger)"></span>Hottest</span>
          <span><span class="legend-dot" style="background:var(--accent-2)"></span>Average</span>
          <span class="muted">last ${state.settings.history_points} samples</span>
        </div>
      </section>

      <div class="page-title-row" style="margin:0 0 12px">
        <h3 class="card-title" style="font-size:15px">Thermal zones</h3>
        <span class="badge muted" id="temp-unit-badge">${tempUnit()}</span>
      </div>
      <div class="sensor-grid" id="sensor-grid">
        <div class="muted tiny">waiting for data…</div>
      </div>`);

    bindNodePageCommon(node);
    state.view = {
      update: updateTemperature,
      redraw: () => { if (state.snapshot && state.view && state.view.update) state.view.update(state.snapshot); },
      error: (message) => showNodeError(message),
    };
    renderCurrentView();
  }

  function tempClass(celsius) {
    if (celsius == null) return "";
    const c = Number(celsius);
    return c >= 80 ? "hot" : c >= 65 ? "warm" : "cool";
  }

  function updateTemperature(data) {
    if (!document.getElementById("temp-max")) return;
    const thermal = data.thermal || {};
    const zones = thermal.zones || [];
    const unitBadge = document.getElementById("temp-unit-badge");
    if (unitBadge) unitBadge.textContent = tempUnit();

    setText("temp-max", fmtTemp(thermal.max));
    setText("temp-avg", fmtTemp(thermal.avg));
    setText("temp-min", fmtTemp(thermal.min));
    setText("temp-count", String(zones.length));
    setText("temp-max-sub", thermal.hottest ? `${thermal.hottest.label || thermal.hottest.name} is hottest` : "no sensors");
    setText("temp-avg-sub", `across ${zones.length} zone${zones.length === 1 ? "" : "s"}`);
    setText("temp-min-sub", thermal.min == null ? "no sensors" : "coolest zone");
    setText("temp-chart-value", thermal.max == null ? "—" : `max ${fmtTemp(thermal.max)} · avg ${fmtTemp(thermal.avg)}`);

    const maxEl = document.getElementById("temp-max");
    if (maxEl) {
      maxEl.classList.remove("hot", "warm", "cool");
      const cls = tempClass(thermal.max);
      if (cls) maxEl.classList.add(cls);
      maxEl.style.color = cls === "hot" ? "var(--danger)" : cls === "warm" ? "var(--warn)" : "var(--ok)";
    }

    drawChart("chart-temp", {
      series: [
        { data: state.history.temp, color: cssVar("--danger"), fill: true },
        { data: state.history.tempAvg, color: cssVar("--accent-2"), fill: false },
      ],
      min: 0,
      unit: tempUnit(),
    });

    const grid = document.getElementById("sensor-grid");
    if (!grid) return;
    if (!zones.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">${icon("thermometer", 24)}</div><div class="empty-title">No thermal zones</div><div class="empty-text">This machine did not expose any readable thermal_zone entries.</div></div>`;
      return;
    }
    if (grid.children.length !== zones.length || !grid.querySelector(".sensor")) {
      grid.innerHTML = zones.map((zone, index) => `
        <article class="sensor" data-zone-index="${index}">
          <div class="sensor-top">
            <span class="sensor-name" data-role="name">—</span>
            <span class="sensor-temp" data-role="temp">—</span>
          </div>
          <div class="sensor-trend" data-role="trend">—</div>
          <div class="sensor-bar"><div class="bar"><i data-role="fill" style="width:0%"></i></div></div>
        </article>`).join("");
    }
    zones.forEach((zone, index) => {
      const card = grid.querySelector(`[data-zone-index="${index}"]`);
      if (!card) return;
      const name = card.querySelector('[data-role="name"]');
      const temp = card.querySelector('[data-role="temp"]');
      const trend = card.querySelector('[data-role="trend"]');
      const fill = card.querySelector('[data-role="fill"]');
      const c = zone.temp == null ? null : Number(zone.temp);
      if (name) name.textContent = zone.label || zone.name || `Zone ${index}`;
      if (temp) {
        temp.textContent = fmtTemp(zone.temp);
        temp.className = `sensor-temp ${tempClass(c)}`;
      }
      if (trend) {
        if (zone.trend > 0) trend.innerHTML = `<span class="trend-up">${icon("arrowUp", 13)} ${fmtDelta(zone.delta)}</span><span class="muted">rising</span>`;
        else if (zone.trend < 0) trend.innerHTML = `<span class="trend-down">${icon("arrowDown", 13)} ${fmtDelta(zone.delta)}</span><span class="muted">falling</span>`;
        else trend.innerHTML = `<span class="trend-flat">${icon("activity", 13)} stable</span>`;
      }
      if (fill) {
        const pct = c == null ? 0 : Math.max(0, Math.min(100, c));
        fill.style.width = `${pct}%`;
        fill.className = c >= 80 ? "danger" : c >= 65 ? "warn" : "ok";
      }
    });
    updateHeaderStatus();
  }

  // ------------------------------------------------------------------------
  // controls
  // ------------------------------------------------------------------------

  function renderControlsPage(node) {
    renderShell({ active: "controls", node, viewLabel: "Controls", showLive: true });
    setHtml("view", `
      ${nodeErrorBanner()}
      ${nodePageHead(node, "Controls", `Power actions for <span class="mono">${escapeHtml(shortAddress(node.address))}</span>. These run immediately on the agent.`, nodeActions(node, "controls"))}

      <div class="banner warn">
        <div class="banner-icon">${icon("shield", 18)}</div>
        <div class="banner-text">
          <strong>Power actions are disruptive.</strong>
          <div class="banner-sub">Rebooting or shutting down will disconnect this node. You must type the node name to confirm.</div>
        </div>
      </div>

      <div class="split-grid">
        <div class="split-col">
          <section class="card">
            <div class="card-head">
              <div><h3 class="card-title">Reboot</h3><div class="card-sub">Restart the machine gracefully.</div></div>
              <div class="card-actions"><span class="badge warn">reboot</span></div>
            </div>
            <div class="card-body">
              <p class="page-sub" style="margin-top:0">Sends <code>reboot</code> to the agent. The node will go offline while it restarts.</p>
              <button class="btn btn-danger btn-block" type="button" data-control-action="reboot">${icon("rotate", 16)} Reboot node</button>
            </div>
          </section>
          <section class="card">
            <div class="card-head">
              <div><h3 class="card-title">Shutdown</h3><div class="card-sub">Power the machine off.</div></div>
              <div class="card-actions"><span class="badge danger">shutdown</span></div>
            </div>
            <div class="card-body">
              <p class="page-sub" style="margin-top:0">Sends <code>shutdown</code> to the agent. You will need physical or remote access to power it back on.</p>
              <button class="btn btn-danger btn-block" type="button" data-control-action="shutdown">${icon("power", 16)} Shut down node</button>
            </div>
          </section>
        </div>
        <div class="split-col">
          <section class="card">
            <div class="card-head">
              <div><h3 class="card-title">Current state</h3><div class="card-sub">Live from the agent</div></div>
              <div class="card-actions"><button class="btn btn-sm" type="button" id="control-check">${icon("refresh", 14)} Check</button></div>
            </div>
            <div class="card-body">
              <div class="info-grid">
                <div class="info-item"><div class="info-label">Status</div><div class="info-value" id="ctl-status">—</div></div>
                <div class="info-item"><div class="info-label">Latency</div><div class="info-value" id="ctl-latency">—</div></div>
                <div class="info-item"><div class="info-label">Hostname</div><div class="info-value" id="ctl-host">—</div></div>
                <div class="info-item"><div class="info-label">Uptime</div><div class="info-value" id="ctl-uptime">—</div></div>
                <div class="info-item"><div class="info-label">Last seen</div><div class="info-value" id="ctl-last">—</div></div>
                <div class="info-item"><div class="info-label">Agent version</div><div class="info-value" id="ctl-version">—</div></div>
              </div>
            </div>
          </section>
          <section class="card">
            <div class="card-head"><div><h3 class="card-title">Safety notes</h3><div class="card-sub">What happens next</div></div></div>
            <div class="card-body">
              <div class="form-note">The agent requires the exact confirmation token <code>REBOOT</code> or <code>SHUTDOWN</code>. This UI also asks you to type the node name so a stray click cannot power off a machine.</div>
            </div>
          </section>
        </div>
      </div>`);

    bindNodePageCommon(node);
    $$("[data-control-action]").forEach((button) => {
      button.addEventListener("click", () => openControlConfirm(node, button.dataset.controlAction));
    });
    const check = document.getElementById("control-check");
    if (check) {
      check.addEventListener("click", async () => {
        setButtonLoading(check, "Checking…");
        try {
          const data = await api(`/api/nodes/${encodeURIComponent(node.id)}/check`, { method: "POST" });
          const status = data.status || {};
          node.last_status = status.status || "unknown";
          node.last_latency_ms = status.latency_ms;
          node.last_error = status.error;
          if (status.status === "online") node.last_seen = new Date().toISOString();
          updateNodeStatuses([{ ...node }]);
          updateControls(state.snapshot || { node: {} }, node);
          toast(status.status === "online" ? "Node is online" : "Node is offline", status.status === "online" ? "ok" : "error");
        } catch (error) {
          toast(error.message, "error");
        }
        restoreButton(check);
      });
    }
    state.view = {
      update: (data) => updateControls(data, node),
      redraw: () => { if (state.snapshot && state.view && state.view.update) state.view.update(state.snapshot); },
      error: (message) => showNodeError(message),
    };
    renderCurrentView();
  }

  function updateControls(data, node) {
    if (!document.getElementById("ctl-status")) return;
    const info = data.node || {};
    const status = state.nodeError ? "offline" : (getNode(state.currentNodeId) || node).last_status || "unknown";
    setText("ctl-status", status);
    setText("ctl-latency", state.latency != null ? `${Math.round(state.latency)}ms` : "—");
    setText("ctl-host", info.hostname || "—");
    setText("ctl-uptime", info.uptime != null ? fmtDuration(info.uptime) : "—");
    setText("ctl-last", node.last_seen ? timeAgo(node.last_seen) : "never");
    setText("ctl-version", info.version ? `v${info.version}` : "—");
    updateHeaderStatus();
  }

  function openControlConfirm(node, action) {
    const isReboot = action === "reboot";
    const token = isReboot ? "REBOOT" : "SHUTDOWN";
    const label = isReboot ? "Reboot" : "Shut down";
    const html = `
      <div class="modal-head">
        <div class="modal-icon danger">${icon(isReboot ? "rotate" : "power", 21)}</div>
        <div style="flex:1">
          <h2 class="modal-title">${label} ${escapeHtml(node.name)}?</h2>
          <p class="modal-sub">The agent will execute <code>${action}</code> immediately. The node will disappear from the monitor until it comes back.</p>
        </div>
        <button class="modal-close" type="button" data-close aria-label="Close">${icon("x", 16)}</button>
      </div>
      <div class="modal-body">
        <div class="danger-box">
          <strong>This is destructive.</strong> Type the node name <code>${escapeHtml(node.name)}</code> to confirm.
        </div>
        <form id="control-form" class="form-grid">
          <label class="field">
            <span class="confirm-label">Node name</span>
            <input class="input mono" name="confirm_name" placeholder="${escapeHtml(node.name)}" autocomplete="off" spellcheck="false" required autofocus>
          </label>
          <div class="field-error" id="control-error"></div>
          <div class="modal-foot" style="padding:0">
            <button class="btn" type="button" data-close>Cancel</button>
            <button class="btn btn-danger" type="submit" id="control-submit">${icon(isReboot ? "rotate" : "power", 15)} ${label}</button>
          </div>
        </form>
      </div>`;
    openModal(html);
    const form = document.getElementById("control-form");
    const errorBox = document.getElementById("control-error");
    const submit = document.getElementById("control-submit");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.textContent = "";
      const typed = String(new FormData(form).get("confirm_name") || "").trim();
      if (typed !== node.name) {
        errorBox.textContent = `Type “${node.name}” exactly to confirm.`;
        return;
      }
      setButtonLoading(submit, isReboot ? "Rebooting…" : "Shutting down…");
      try {
        const result = await api(`/api/nodes/${encodeURIComponent(node.id)}/control`, {
          method: "POST",
          body: JSON.stringify({ action, confirm: token }),
        });
        closeModal();
        if (result.ok === false && result.error) toast(result.error, "error");
        else toast(`${node.name}: ${action} command sent`, "ok");
        node.last_status = "offline";
        updateNodeStatuses([{ ...node }]);
      } catch (error) {
        errorBox.textContent = error.message;
        restoreButton(submit);
      }
    });
  }

  // ------------------------------------------------------------------------
  // btop
  // ------------------------------------------------------------------------

  function renderBtopPage(node) {
    renderShell({ active: "btop", node, viewLabel: "BTOP++", showLive: true });
    setHtml("view", `
      ${nodeErrorBanner()}
      ${nodePageHead(node, "BTOP++", `Interactive process monitor on <span class="mono">${escapeHtml(shortAddress(node.address))}</span>. Start it to run <code>btop</code> in a live terminal.`, nodeActions(node, "btop"))}

      <section class="card terminal-card">
        <div class="terminal">
          <div class="term-head">
            <div class="term-dots"><span class="term-dot red"></span><span class="term-dot yellow"></span><span class="term-dot green"></span></div>
            <div class="term-title" id="btop-title">BTOP++ — ${escapeHtml(node.name)}</div>
            <div class="term-tools">
              <button class="term-tool" type="button" id="btop-start">start</button>
              <button class="term-tool" type="button" id="btop-stop">stop</button>
              <button class="term-tool" type="button" id="btop-fit">fit</button>
            </div>
          </div>
          <div class="term-body" id="btop-term" style="height:72vh;min-height:420px;padding:0"></div>
          <div class="term-hint">Runs <code>btop</code> on the agent in an interactive PTY. Click the terminal to focus; keyboard and mouse are forwarded.</div>
        </div>
      </section>`);

    const container = document.getElementById("btop-term");
    if (!container) return;
    const session = { node, term: null, fit: null, es: null, sessionId: null, running: false };

    try {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: Number(state.settings.terminal_font_size) || 13,
        fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
        theme: { background: "#020617", foreground: "#e7eefb", cursor: "#22d3ee" },
        scrollback: 1000,
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      term.onData((data) => {
        if (session.running && session.sessionId) {
          api(`/api/nodes/${encodeURIComponent(node.id)}/pty/input`, {
            method: "POST",
            body: JSON.stringify({ session: session.sessionId, data }),
          }).catch(() => {});
        }
      });
      term.onResize(({ cols, rows }) => {
        if (session.running && session.sessionId) {
          api(`/api/nodes/${encodeURIComponent(node.id)}/pty/resize`, {
            method: "POST",
            body: JSON.stringify({ session: session.sessionId, cols, rows }),
          }).catch(() => {});
        }
      });
      window.addEventListener("resize", () => { try { fit.fit(); } catch (e) {} });
      session.term = term;
      session.fit = fit;
    } catch (error) {
      setHtml("view", `<div class="empty"><div class="empty-title">Terminal library failed to load</div><div class="empty-text">${escapeHtml(error.message)}</div></div>`);
      return;
    }

    const startBtn = document.getElementById("btop-start");
    const stopBtn = document.getElementById("btop-stop");
    const fitBtn = document.getElementById("btop-fit");
    if (startBtn) startBtn.addEventListener("click", async () => {
      if (session.running) return;
      session.term.reset();
      const cols = session.term.cols || 120;
      const rows = session.term.rows || 32;
      setButtonLoading(startBtn, "Starting…");
      try {
        const result = await api(`/api/nodes/${encodeURIComponent(node.id)}/pty/start`, {
          method: "POST",
          body: JSON.stringify({ command: "btop", cols, rows }),
        });
        session.sessionId = result.session;
        session.running = true;
        const es = new EventSource(`/api/nodes/${encodeURIComponent(node.id)}/pty/stream?session=${encodeURIComponent(session.sessionId)}`);
        session.es = es;
        es.onmessage = (event) => {
          try {
            const binary = atob(event.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            session.term.write(bytes);
          } catch (e) {}
        };
        es.addEventListener("close", () => {
          session.running = false;
          if (startBtn) restoreButton(startBtn);
        });
        es.onerror = () => {
          if (session.running) {
            session.term.write("\r\n\x1b[31mStream closed.\x1b[0m\r\n");
            session.running = false;
            if (session.es) { session.es.close(); session.es = null; }
            if (startBtn) restoreButton(startBtn);
          }
        };
        if (fitBtn) fitBtn.onclick = () => { try { session.fit.fit(); } catch (e) {} };
        session.term.focus();
        restoreButton(startBtn);
        if (startBtn) startBtn.textContent = "running";
      } catch (error) {
        session.term.write(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
        restoreButton(startBtn);
      }
    });
    if (stopBtn) stopBtn.addEventListener("click", async () => {
      if (!session.running || !session.sessionId) return;
      setButtonLoading(stopBtn, "Stopping…");
      try {
        await api(`/api/nodes/${encodeURIComponent(node.id)}/pty/stop`, {
          method: "POST",
          body: JSON.stringify({ session: session.sessionId }),
        });
      } catch (e) {}
      if (session.es) { session.es.close(); session.es = null; }
      session.running = false;
      session.sessionId = null;
      restoreButton(stopBtn);
      if (startBtn) startBtn.textContent = "start";
    });
    if (fitBtn) fitBtn.addEventListener("click", () => { try { session.fit.fit(); } catch (e) {} });

    bindNodePageCommon(node);
    state.view = {
      update: () => {},
      redraw: () => { try { session.fit.fit(); } catch (e) {} },
    };
    setTimeout(() => { try { session.fit.fit(); } catch (e) {} }, 100);
  }

  // terminal
  // ------------------------------------------------------------------------

  function terminalState(nodeId) {
    let term = state.terminals[nodeId];
    if (!term) {
      term = {
        lines: [],
        history: [],
        historyIndex: -1,
        running: false,
        cwd: "/root",
        hostname: "node",
        fontSize: Number(state.settings.terminal_font_size) || 13,
      };
      state.terminals[nodeId] = term;
    }
    return term;
  }

  function renderTerminalPage(node) {
    const term = terminalState(node.id);
    renderShell({ active: "terminal", node, viewLabel: "Terminal", showLive: true });
    setHtml("view", `
      ${nodeErrorBanner()}
      ${nodePageHead(node, "Terminal", `Run shell commands on <span class="mono">${escapeHtml(shortAddress(node.address))}</span>. Each command runs in a fresh bash process.`, nodeActions(node, "terminal"))}

      <section class="card terminal-card">
        <div class="terminal">
          <div class="term-head">
            <div class="term-dots"><span class="term-dot red"></span><span class="term-dot yellow"></span><span class="term-dot green"></span></div>
            <div class="term-title" id="term-title">root@${escapeHtml(term.hostname)} — bash</div>
            <div class="term-tools">
              <button class="term-tool" type="button" data-term-tool="clear" title="Clear output">clear</button>
              <button class="term-tool" type="button" data-term-tool="font-down" title="Smaller text">A−</button>
              <button class="term-tool" type="button" data-term-tool="font-up" title="Larger text">A+</button>
              <button class="term-tool" type="button" data-term-tool="bottom" title="Scroll to bottom">bottom</button>
            </div>
          </div>
          <div class="term-body" id="term-body"></div>
          <div class="term-input-row" id="term-input-row">
            <span class="term-prompt" id="term-prompt"><span class="p-host">root@${escapeHtml(term.hostname)}</span>:<span class="p-path">${escapeHtml(shortCwd(term.cwd))}</span>$</span>
            <input class="term-input" id="term-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="type a command and press Enter…" aria-label="Command">
            <span class="term-status" id="term-status">ready</span>
          </div>
          <div class="term-hint">Commands run through <code>bash -lc</code> on the agent. Use ↑ / ↓ for history, Ctrl+L to clear, and <code>cd</code> to change the working directory.</div>
        </div>
      </section>`);

    const termBody = document.getElementById("term-body");
    const input = document.getElementById("term-input");
    const row = document.getElementById("term-input-row");
    if (termBody) termBody.style.setProperty("--term-font-size", `${term.fontSize}px`);
    if (input) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          runTerminalCommand(node, term);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          if (!term.history.length) return;
          term.historyIndex = term.historyIndex < 0 ? term.history.length - 1 : Math.max(0, term.historyIndex - 1);
          input.value = term.history[term.historyIndex] || "";
          input.setSelectionRange(input.value.length, input.value.length);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          if (!term.history.length) return;
          if (term.historyIndex < 0) return;
          term.historyIndex += 1;
          if (term.historyIndex >= term.history.length) {
            term.historyIndex = -1;
            input.value = "";
          } else {
            input.value = term.history[term.historyIndex] || "";
            input.setSelectionRange(input.value.length, input.value.length);
          }
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          clearTerminal(term);
        }
      });
    }
    if (row) row.addEventListener("click", () => { if (input) input.focus(); });
    $$("[data-term-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        const tool = button.dataset.termTool;
        if (tool === "clear") clearTerminal(term);
        else if (tool === "bottom") scrollTerminal(true);
        else if (tool === "font-up") changeTerminalFont(term, 1);
        else if (tool === "font-down") changeTerminalFont(term, -1);
      });
    });

    bindNodePageCommon(node);
    updateTerminalPrompt(term);
    renderTerminalBody(term, true);
    state.view = {
      update: (data) => updateTerminal(data, term),
      redraw: () => updateTerminalPrompt(term),
      error: (message) => showNodeError(message),
    };
    setTimeout(() => { if (input) input.focus(); }, 40);
  }

  function updateTerminal(data, term) {
    const info = data.node || {};
    if (info.hostname) term.hostname = info.hostname;
    if (info.cwd) term.cwd = info.cwd;
    const title = document.getElementById("term-title");
    if (title) title.textContent = `root@${term.hostname} — bash`;
    updateTerminalPrompt(term);
    updateHeaderStatus();
  }

  function updateTerminalPrompt(term) {
    const prompt = document.getElementById("term-prompt");
    if (!prompt) return;
    prompt.innerHTML = `<span class="p-host">root@${escapeHtml(term.hostname)}</span>:<span class="p-path">${escapeHtml(shortCwd(term.cwd))}</span>$`;
  }

  function changeTerminalFont(term, delta) {
    term.fontSize = Math.max(10, Math.min(20, term.fontSize + delta));
    const body = document.getElementById("term-body");
    if (body) body.style.setProperty("--term-font-size", `${term.fontSize}px`);
  }

  function promptText(term) {
    return `root@${term.hostname}:${shortCwd(term.cwd)}$`;
  }

  function clearTerminal(term) {
    term.lines = [];
    renderTerminalBody(term, true);
  }

  function scrollTerminal(force = false) {
    const body = document.getElementById("term-body");
    if (!body) return;
    if (force || body.scrollHeight - body.scrollTop - body.clientHeight < 90) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function renderTerminalBody(term, forceScroll = false) {
    const body = document.getElementById("term-body");
    if (!body) return;
    body.innerHTML = term.lines.join("\n");
    scrollTerminal(forceScroll);
  }

  function appendTerminal(term, html) {
    const max = Math.max(100, Number(state.settings.terminal_max_lines) || 600);
    term.lines.push(html);
    while (term.lines.length > max) term.lines.shift();
    renderTerminalBody(term, true);
  }

  async function runTerminalCommand(node, term) {
    if (term.running) return;
    const input = document.getElementById("term-input");
    if (!input) return;
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    if (term.history[term.history.length - 1] !== command) term.history.push(command);
    term.historyIndex = -1;

    const echo = `<span class="t-green">${escapeHtml(promptText(term))}</span> <span class="t-white">${escapeHtml(command)}</span>`;
    appendTerminal(term, echo);

    term.running = true;
    input.disabled = true;
    setTerminalStatus("running…", true);
    try {
      const result = await api(`/api/nodes/${encodeURIComponent(node.id)}/terminal`, {
        method: "POST",
        body: JSON.stringify({ command }),
      });
      if (result.stdout) appendTerminal(term, ansiToHtml(result.stdout.replace(/\r/g, "")));
      if (result.stderr) appendTerminal(term, `<span class="t-red">${ansiToHtml(result.stderr.replace(/\r/g, ""))}</span>`);
      if (result.error) appendTerminal(term, `<span class="t-red">${escapeHtml(result.error)}</span>`);
      if (result.cwd) term.cwd = result.cwd;
      if (result.timed_out) appendTerminal(term, `<span class="t-yellow">Command timed out and was killed.</span>`);
      if (result.exit_code !== undefined && result.exit_code !== 0) {
        appendTerminal(term, `<span class="t-dim">exit ${result.exit_code} · ${result.duration_ms || 0}ms</span>`);
      }
      updateTerminalPrompt(term);
      setTerminalStatus("ready");
    } catch (error) {
      appendTerminal(term, `<span class="t-red">${escapeHtml(error.message)}</span>`);
      setTerminalStatus("error", false, true);
    } finally {
      term.running = false;
      input.disabled = false;
      input.focus();
    }
  }

  function setTerminalStatus(text, running = false, error = false) {
    const status = document.getElementById("term-status");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("running", !!running);
    status.style.color = error ? "var(--danger)" : "";
  }

  function ansiToHtml(input) {
    const text = String(input == null ? "" : input);
    if (!text) return "";
    const re = /\x1b\[([0-9;]*)m/g;
    let html = "";
    let last = 0;
    let classes = [];
    let match;
    const wrap = (chunk) => {
      const safe = escapeHtml(chunk);
      if (!safe) return "";
      return classes.length ? `<span class="${classes.join(" ")}">${safe}</span>` : safe;
    };
    while ((match = re.exec(text)) !== null) {
      html += wrap(text.slice(last, match.index));
      last = re.lastIndex;
      const codes = match[1] === "" ? [0] : match[1].split(";").map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
      codes.forEach((code) => {
        if (code === 0) classes = [];
        else if (code === 1) addClass(classes, "t-bold");
        else if (code === 2) addClass(classes, "t-dim");
        else if (code === 4) addClass(classes, "t-underline");
        else if (code === 22) classes = classes.filter((c) => c !== "t-bold" && c !== "t-dim");
        else if (code === 24) classes = classes.filter((c) => c !== "t-underline");
        else if (code === 39) classes = classes.filter((c) => !c.startsWith("t-fg-"));
        else if (code >= 30 && code <= 37) setFg(classes, code - 30);
        else if (code >= 90 && code <= 97) setFg(classes, code - 90, true);
        else if (code === 38 || code === 48) { /* extended colors are ignored */ }
      });
    }
    html += wrap(text.slice(last));
    return html;
  }

  const FG = ["t-gray", "t-red", "t-green", "t-yellow", "t-blue", "t-magenta", "t-cyan", "t-white"];
  function setFg(classes, index, bright = false) {
    for (let i = classes.length - 1; i >= 0; i -= 1) {
      if (classes[i].startsWith("t-fg-") || FG.includes(classes[i])) classes.splice(i, 1);
    }
    const name = FG[Math.max(0, Math.min(FG.length - 1, index))] || "t-white";
    classes.push(`t-fg-${index}`, name);
    if (bright) addClass(classes, "t-bold");
  }
  function addClass(classes, name) {
    if (!classes.includes(name)) classes.push(name);
  }

  // ------------------------------------------------------------------------
  // charts
  // ------------------------------------------------------------------------

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
  }

  function setupCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function drawChart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;
    const series = (config.series || []).filter(Boolean);
    if (!series.length) return;
    const pad = { l: 2, r: 2, t: 6, b: 4 };
    const plotW = Math.max(1, width - pad.l - pad.r);
    const plotH = Math.max(1, height - pad.t - pad.b);

    const all = series.flatMap((s) => (s.data || []).filter((v) => v != null && isFinite(v)));
    let min = config.min != null ? config.min : 0;
    let max = config.max != null ? config.max : Math.max.apply(null, all.length ? all : [1]);
    if (!isFinite(max) || max <= min) max = min + 1;
    if (config.max == null) max = niceCeil(max * 1.12);

    if (state.settings.show_grid) {
      const grid = config.gridLines || [0.25, 0.5, 0.75];
      ctx.strokeStyle = cssVar("--border");
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      grid.forEach((ratio) => {
        const y = pad.t + plotH - plotH * ratio;
        ctx.beginPath();
        ctx.moveTo(pad.l, Math.round(y) + 0.5);
        ctx.lineTo(width - pad.r, Math.round(y) + 0.5);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }

    series.forEach((s) => {
      const data = s.data || [];
      const count = data.length;
      if (!count) return;
      const step = count > 1 ? plotW / (count - 1) : 0;
      const points = [];
      data.forEach((value, index) => {
        if (value == null || !isFinite(value)) return;
        const x = pad.l + step * index;
        const ratio = Math.max(0, Math.min(1, (Number(value) - min) / (max - min)));
        const y = pad.t + plotH - ratio * plotH;
        points.push({ x, y });
      });
      if (!points.length) return;

      if (s.fill && points.length > 1) {
        const gradient = ctx.createLinearGradient(0, pad.t, 0, height);
        gradient.addColorStop(0, hexToRgba(s.color, 0.26));
        gradient.addColorStop(1, hexToRgba(s.color, 0.01));
        ctx.beginPath();
        ctx.moveTo(points[0].x, height - pad.b);
        points.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.lineTo(points[points.length - 1].x, height - pad.b);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      ctx.beginPath();
      points.forEach((p, index) => {
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.9;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    });
  }

  function drawSpark(id, data, color, fixedMax) {
    if (!state.settings.show_sparklines) return;
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;
    const values = (data || []).filter((v) => v != null && isFinite(v));
    if (values.length < 2) return;
    const min = 0;
    let max = fixedMax != null ? fixedMax : Math.max.apply(null, values);
    if (!isFinite(max) || max <= min) max = min + 1;
    if (fixedMax == null) max = niceCeil(max * 1.15);
    const pad = 3;
    const plotW = Math.max(1, width - pad * 2);
    const plotH = Math.max(1, height - pad * 2);
    const step = plotW / (values.length - 1);
    const points = values.map((value, index) => ({
      x: pad + step * index,
      y: pad + plotH - Math.max(0, Math.min(1, (value - min) / (max - min))) * plotH,
    }));
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, hexToRgba(color, 0.3));
    gradient.addColorStop(1, hexToRgba(color, 0.01));
    ctx.beginPath();
    ctx.moveTo(points[0].x, height - pad);
    points.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, height - pad);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    points.forEach((p, index) => {
      if (index === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.stroke();
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function niceCeil(value) {
    if (!isFinite(value) || value <= 0) return 1;
    const exp = Math.floor(Math.log10(value));
    const base = Math.pow(10, exp);
    const norm = value / base;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * base;
  }

  function hexToRgba(color, alpha) {
    const value = String(color || "").trim();
    if (value.startsWith("#")) {
      let hex = value.slice(1);
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const num = parseInt(hex, 16);
      if (!isNaN(num)) {
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r},${g},${b},${alpha})`;
      }
    }
    if (value.startsWith("rgb")) {
      return value.replace(/rgba?\(([^)]+)\)/, (_, inner) => {
        const parts = inner.split(",").map((p) => p.trim()).slice(0, 3);
        return `rgba(${parts.join(",")},${alpha})`;
      });
    }
    return value;
  }

  // ------------------------------------------------------------------------
  // settings
  // ------------------------------------------------------------------------

  async function renderSettingsPage() {
    try {
      const data = await api("/api/settings");
      state.defaults = data.defaults || state.defaults;
      applySettings(data.settings || state.settings);
    } catch (_) { /* use boot settings */ }
    const s = state.settings;
    renderShell({ active: "settings", node: null, viewLabel: "Settings", showLive: false });
    setHtml("view", `
      <div class="page-head">
        <div>
          <div class="page-title-row"><h1 class="page-title">Settings</h1><span class="badge muted">global</span></div>
          <p class="page-sub">Global preferences for every node. Changes are stored in SQLite and broadcast to all open dashboards.</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" id="settings-reset">${icon("rotate", 15)} Reset defaults</button>
          <button class="btn btn-primary" type="submit" form="settings-form" id="settings-save">${icon("save", 15)} Save changes</button>
        </div>
      </div>

      <div class="settings-note">
        ${icon("zap", 18)}
        <div>Refresh interval controls how often the website asks each node for a snapshot. Lower values feel snappier but use more CPU. The agent itself is sampled independently.</div>
      </div>

      <form id="settings-form" class="card">
        <div class="card-body settings-grid">
          ${settingRange("refresh_ms", "Refresh interval", "How often live metrics are fetched from the selected node.", s.refresh_ms, 250, 5000, 50, `${s.refresh_ms}ms`)}
          ${settingRange("history_points", "History points", "Number of samples kept in the live charts.", s.history_points, 20, 300, 10, `${s.history_points} points`)}
          ${settingRange("node_timeout_ms", "Node timeout", "How long to wait for a node before marking it unreachable.", s.node_timeout_ms, 1000, 15000, 500, `${s.node_timeout_ms}ms`)}
          ${settingSelect("temperature_unit", "Temperature unit", "Display temperatures in Celsius or Fahrenheit.", s.temperature_unit, [["C", "Celsius (°C)"], ["F", "Fahrenheit (°F)"]])}
          ${settingRange("terminal_font_size", "Terminal font size", "Default font size for the web terminal.", s.terminal_font_size, 10, 20, 1, `${s.terminal_font_size}px`)}
          ${settingRange("terminal_max_lines", "Terminal scrollback", "Maximum number of terminal lines kept in the browser.", s.terminal_max_lines, 100, 3000, 100, `${s.terminal_max_lines} lines`)}
          ${settingToggle("compact", "Compact layout", "Reduce padding and card sizes to fit more on screen.", s.compact)}
          ${settingToggle("animations", "Animations", "Enable hover transitions, pulses and chart animations.", s.animations)}
          ${settingToggle("show_grid", "Chart grid lines", "Show horizontal guide lines behind live charts.", s.show_grid)}
          ${settingToggle("show_sparklines", "KPI sparklines", "Show the small history graphs inside KPI cards.", s.show_sparklines)}
          ${settingToggle("clock_24h", "24-hour clock", "Use 24-hour time in the top bar.", s.clock_24h)}
        </div>
      </form>

      <div class="settings-note" style="margin-top:18px">
        ${icon("shield", 18)}
        <div>Settings apply to the control plane only. Node API keys and agent ports are managed on each node and are never changed from here.</div>
      </div>`);

    bindSettingsForm();
    const reset = document.getElementById("settings-reset");
    if (reset) {
      reset.addEventListener("click", async () => {
        setButtonLoading(reset, "Resetting…");
        try {
          const data = await api("/api/settings", { method: "PUT", body: JSON.stringify(state.defaults) });
          applySettings(data.settings);
          toast("Settings reset to defaults", "ok");
          renderSettingsPage();
        } catch (error) {
          toast(error.message, "error");
          restoreButton(reset);
        }
      });
    }
    state.view = null;
  }

  function settingRow(key, name, desc, control) {
    return `
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">${escapeHtml(name)}</div>
          <div class="setting-desc">${escapeHtml(desc)}</div>
        </div>
        <div class="setting-control">${control}</div>
      </div>`;
  }

  function settingRange(key, name, desc, value, min, max, step, display) {
    return settingRow(key, name, desc, `
      <div class="range-row" style="width:100%">
        <input type="range" name="${key}" min="${min}" max="${max}" step="${step}" value="${value}" data-range-key="${key}">
        <span class="range-val" data-range-val="${key}">${escapeHtml(display)}</span>
      </div>`);
  }

  function settingSelect(key, name, desc, value, options) {
    return settingRow(key, name, desc, `
      <select class="select" name="${key}">
        ${options.map(([val, label]) => `<option value="${escapeHtml(val)}" ${String(value) === String(val) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
      </select>`);
  }

  function settingToggle(key, name, desc, value) {
    return settingRow(key, name, desc, `
      <label class="switch">
        <input type="checkbox" name="${key}" ${value ? "checked" : ""}>
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label">${value ? "On" : "Off"}</span>
      </label>`);
  }

  function rangeDisplay(key, value) {
    const n = Number(value);
    if (key === "refresh_ms" || key === "node_timeout_ms") return `${n}ms`;
    if (key === "history_points") return `${n} points`;
    if (key === "terminal_font_size") return `${n}px`;
    if (key === "terminal_max_lines") return `${n} lines`;
    return String(n);
  }

  function bindSettingsForm() {
    const form = document.getElementById("settings-form");
    if (!form) return;
    $$("[data-range-key]", form).forEach((input) => {
      input.addEventListener("input", () => {
        const out = form.querySelector(`[data-range-val="${input.dataset.rangeKey}"]`);
        if (out) out.textContent = rangeDisplay(input.dataset.rangeKey, input.value);
      });
    });
    $$(".switch input", form).forEach((input) => {
      input.addEventListener("change", () => {
        const label = input.closest(".switch").querySelector(".switch-label");
        if (label) label.textContent = input.checked ? "On" : "Off";
      });
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const payload = {
        refresh_ms: Number(fd.get("refresh_ms")),
        history_points: Number(fd.get("history_points")),
        node_timeout_ms: Number(fd.get("node_timeout_ms")),
        terminal_font_size: Number(fd.get("terminal_font_size")),
        terminal_max_lines: Number(fd.get("terminal_max_lines")),
        temperature_unit: String(fd.get("temperature_unit")),
        compact: fd.get("compact") === "on",
        animations: fd.get("animations") === "on",
        show_grid: fd.get("show_grid") === "on",
        show_sparklines: fd.get("show_sparklines") === "on",
        clock_24h: fd.get("clock_24h") === "on",
      };
      const save = document.getElementById("settings-save");
      setButtonLoading(save, "Saving…");
      try {
        const data = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
        applySettings(data.settings);
        toast("Settings saved", "ok");
        renderSettingsPage();
      } catch (error) {
        toast(error.message, "error");
        restoreButton(save);
      }
    });
  }

  // ------------------------------------------------------------------------
  // theme
  // ------------------------------------------------------------------------

  const FALLBACK_THEMES = [
    { id: "midnight", name: "Midnight", description: "Deep indigo with electric cyan accents." },
    { id: "carbon", name: "Carbon", description: "Near-black graphite with warm amber." },
    { id: "ocean", name: "Ocean", description: "Abyss blue with bright aqua highlights." },
    { id: "neon", name: "Neon", description: "Ultraviolet glow for night owls." },
    { id: "sunset", name: "Sunset", description: "Smoked plum with coral and rose." },
    { id: "light", name: "Daylight", description: "Bright, calm and easy on the eyes." },
  ];

  async function renderThemePage() {
    let themes = state.themes && state.themes.length ? state.themes : FALLBACK_THEMES;
    try {
      const data = await api("/api/theme");
      themes = data.themes || themes;
      state.themes = themes;
      if (data.theme) applyTheme(data.theme);
    } catch (_) { /* keep boot theme */ }
    renderShell({ active: "theme", node: null, viewLabel: "Theme", showLive: false });
    setHtml("view", `
      <div class="page-head">
        <div>
          <div class="page-title-row"><h1 class="page-title">Theme</h1><span class="badge muted">global</span></div>
          <p class="page-sub">Pick a palette for the control plane. The choice is saved globally and broadcast to every open dashboard.</p>
        </div>
        <div class="page-actions"><span class="badge ok">${icon("palette", 13)} ${escapeHtml(currentThemeName(themes))}</span></div>
      </div>
      <div class="theme-grid" id="theme-grid">
        ${themes.map((theme) => themeCardHtml(theme)).join("")}
      </div>
      <div class="settings-note" style="margin-top:18px">
        ${icon("palette", 18)}
        <div>Theme previews show the accent colors and panel tones. Charts and sparklines redraw automatically after switching.</div>
      </div>`);

    const grid = document.getElementById("theme-grid");
    if (grid) {
      grid.addEventListener("click", async (event) => {
        const card = event.target.closest("[data-theme-id]");
        if (!card) return;
        const id = card.dataset.themeId;
        if (id === state.theme) return;
        try {
          const data = await api("/api/theme", { method: "PUT", body: JSON.stringify({ theme: id }) });
          applyTheme(data.theme || id);
          $$("[data-theme-id]", grid).forEach((el) => el.classList.toggle("active", el.dataset.themeId === id));
          const badge = document.querySelector(".page-actions .badge");
          if (badge) badge.innerHTML = `${icon("palette", 13)} ${escapeHtml(currentThemeName(themes))}`;
          toast(`${currentThemeName(themes)} theme applied`, "ok");
        } catch (error) {
          toast(error.message, "error");
        }
      });
    }
    state.view = null;
  }

  function currentThemeName(themes) {
    const found = (themes || []).find((t) => t.id === state.theme);
    return found ? found.name : state.theme;
  }

  function themeCardHtml(theme) {
    const active = theme.id === state.theme;
    return `
      <button class="theme-card ${active ? "active" : ""}" type="button" data-theme-id="${escapeHtml(theme.id)}">
        <div class="theme-preview ${escapeHtml(theme.id)}">
          <div class="tp-row"><span class="tp-chip a"></span><span class="tp-chip"></span><span class="tp-chip"></span></div>
          <div class="tp-bar w1"></div>
          <div class="tp-bar w2"></div>
          <div class="tp-row"><span class="tp-chip"></span><span class="tp-chip"></span></div>
          <div class="tp-bar w3"></div>
        </div>
        <div class="theme-meta">
          <div>
            <div class="theme-name">${escapeHtml(theme.name)}</div>
            <div class="theme-desc">${escapeHtml(theme.description || "")}</div>
          </div>
          <div class="theme-check">${icon("check", 13)}</div>
        </div>
      </button>`;
  }

  // ------------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------------

  function handleResize() {
    if (state.view && state.view.redraw) state.view.redraw();
  }

  async function init() {
    applyTheme(BOOT.theme || "midnight");
    applySettings(BOOT.settings || {});
    if (Array.isArray(BOOT.themes) && BOOT.themes.length) state.themes = BOOT.themes;
    bindLinks();
    initSocket();
    updateClock();
    setInterval(updateClock, 1000);
    window.addEventListener("resize", debounce(handleResize, 120));
    try {
      const meta = await api("/api/meta");
      if (meta.theme) applyTheme(meta.theme);
      if (meta.settings) applySettings(meta.settings);
      if (meta.defaults) state.defaults = meta.defaults;
      if (Array.isArray(meta.themes) && meta.themes.length) state.themes = meta.themes;
    } catch (_) { /* offline boot */ }
    await loadNodes(true);
    await renderRoute();
  }

  init();
})();
