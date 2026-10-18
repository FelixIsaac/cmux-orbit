// cmux-orbit — Calm, Apple/Linear-Grade Mobile Mission Control Client
import { AnsiUp } from "./vendor/ansi_up.js";

const ansiUp = new AnsiUp();
ansiUp.use_classes = false;
ansiUp.escape_html = true;

const AGENT_META = {
  claude: { icon: "✦", label: "Claude", cls: "claude" },
  grok: { icon: "𝕏", label: "Grok", cls: "grok" },
  codex: { icon: "⚡", label: "Codex", cls: "codex" },
  pi: { icon: "π", label: "Pi", cls: "pi" },
  antigravity: { icon: "▲", label: "Agy", cls: "antigravity" },
  markdown: { icon: "📄", label: "Doc", cls: "markdown" },
  shell: { icon: ">_", label: "Shell", cls: "shell" },
};

const state = {
  connected: false,
  screen: "mission", // "mission" | "surface"
  filter: "all", // "all" | "needs_input" | "active" | "vault"
  dashboard: loadCachedDashboard(),
  dashboardJson: null,
  activeWorkspaceId: null,
  activeSurfaceId: null,
  surfaceDetail: null,
  surfaceLoading: false,
  viewMode: "agent", // "agent" | "terminal" | "diff" | "markdown"
  peekModePrev: null,
  terminalWrap: true,
  terminalFontSize: 12.5,
  gitDiffData: null,
  gitDiffLoading: false,
  docPreview: null,
  composerMode: "ask", // "ask" | "shell"
  composerText: "",
  activeModal: null, // null | "spawn" | "ws_switcher" | "shortcuts" | "telemetry" | "vault_preview"
  openDetails: new Set(), // tracks open <details data-details-id="..."> keys across background updates
  draftsBySurface: {}, // surfaceId -> string draft
  scrollBySurface: {}, // surfaceId -> number scrollTop
  viewModeBySurface: {}, // surfaceId -> string mode
  spawnForm: {
    target: "surface", // "surface" | "workspace"
    preset: "claude",
    command: "claude",
    title: "",
    cwd: "",
    initialPrompt: "",
  },
  vaultQuery: "",
  vaultResults: [],
  vaultSelectedSession: null,
  vaultMessages: [],
};

function loadCachedDashboard() {
  try {
    const raw = localStorage.getItem("cmux_orbit_dashboard_v1");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCachedDashboard(data) {
  try {
    localStorage.setItem("cmux_orbit_dashboard_v1", JSON.stringify(data));
  } catch {
    // ignore
  }
}

function hapticTick(style = "light") {
  try {
    if (window.webkit?.messageHandlers?.orbitNative) {
      window.webkit.messageHandlers.orbitNative.postMessage({
        type: "haptic",
        style,
      });
      return;
    }
    if (navigator.vibrate) navigator.vibrate(style === "medium" ? 14 : 8);
  } catch {
    // ignore
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.copyCodeSnippet = function (btn) {
  const wrapper = btn.closest(".code-block-wrapper");
  const code = wrapper ? wrapper.querySelector("code")?.innerText || "" : "";
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => {
      hapticTick("medium");
      const orig = btn.innerText;
      btn.innerText = "✓ Copied";
      setTimeout(() => {
        btn.innerText = orig;
      }, 1800);
    });
  }
};

function highlightCode(code, lang = "") {
  let text = escapeHtml(code);
  const l = (lang || "").toLowerCase();
  if (!l || l === "text" || l === "plain" || l === "txt") {
    return text;
  }

  // Comments (// ... or # ...)
  const comments = [];
  text = text.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, (match) => {
    const idx = comments.length;
    comments.push(`<span class="token-comment">${match}</span>`);
    return `@@COMMENT_${idx}@@`;
  });

  // Strings ("...", '...', `...`)
  const strings = [];
  text = text.replace(/("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`)/g, (match) => {
    const idx = strings.length;
    strings.push(`<span class="token-string">${match}</span>`);
    return `@@STRING_${idx}@@`;
  });

  // Numbers & Booleans
  text = text.replace(/\b(true|false|null|undefined|nil|None|True|False)\b/g, '<span class="token-boolean">$1</span>');
  text = text.replace(/\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="token-number">$1</span>');

  // Keywords
  const kwRegex = /\b(const|let|var|function|return|import|export|from|as|default|class|extends|interface|type|enum|implements|public|private|protected|readonly|static|async|await|yield|new|this|super|if|else|switch|case|break|continue|for|while|do|in|of|try|catch|finally|throw|typeof|instanceof|void|def|self|lambda|with|elif|print|func|struct|mut|impl|pub|fn|select|where|join|insert|update|delete)\b/g;
  text = text.replace(kwRegex, '<span class="token-keyword">$1</span>');

  // Types & Builtins
  text = text.replace(/\b(string|number|boolean|any|void|unknown|never|object|Array|Promise|Record|Map|Set|int|float|str|dict|list|bool)\b/g, '<span class="token-type">$1</span>');

  // Function calls
  text = text.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g, '<span class="token-fn">$1</span>');

  // Restore Strings & Comments
  text = text.replace(/@@STRING_(\d+)@@/g, (_, i) => strings[Number(i)] || "");
  text = text.replace(/@@COMMENT_(\d+)@@/g, (_, i) => comments[Number(i)] || "");

  return text;
}

function colorizeTerminalBuffer(rawText) {
  let text = escapeHtml(rawText);
  const lines = text.split("\n");
  const colored = lines.map((line) => {
    if (/^\s*[❯›$%]\s+/.test(line)) {
      return `<span class="term-prompt">${line}</span>`;
    }
    if (/^\s*[✓✔]\s+/.test(line) || /status:\s*success|build succeeded/i.test(line)) {
      return `<span class="term-success">${line}</span>`;
    }
    if (/^\s*[✗✖!]\s+/.test(line) || /\b(error|failed|fatal|exception)\b/i.test(line)) {
      return `<span class="term-error">${line}</span>`;
    }
    if (/\b(warn|warning)\b/i.test(line)) {
      return `<span class="term-warn">${line}</span>`;
    }
    if (/^\+[^+]/.test(line)) {
      return `<span class="diff-add">${line}</span>`;
    }
    if (/^-[^-]/.test(line)) {
      return `<span class="diff-del">${line}</span>`;
    }
    if (/^[─━═╭╰┌└│┃\s]{6,}$/.test(line)) {
      return `<span class="term-border">${line}</span>`;
    }
    if (/\|.*t\/s.*\|\s*SID:/i.test(line) || /^ctx:\s*.*cmpct:/i.test(line)) {
      return `<span class="term-telemetry">${line}</span>`;
    }
    return line;
  });
  return colored.join("\n");
}

function renderTerminalAnsi(rawText) {
  if (!rawText) return "";
  if (rawText.includes("\x1b[") || rawText.includes("\u001b[")) {
    try {
      return ansiUp.ansi_to_html(rawText);
    } catch {
      return colorizeTerminalBuffer(rawText);
    }
  }
  return colorizeTerminalBuffer(rawText);
}

let activeTerminalInstance = null;
let activeTerminalFitAddon = null;
let activeTerminalSurfaceId = null;
let lastTerminalAnsiRendered = null;

function ensureXtermMounted(rawAnsi) {
  const container = document.getElementById("xterm-container");
  if (!container) return;

  if (typeof window.Terminal === "undefined") {
    container.innerHTML = `<pre class="terminal-box ${state.terminalWrap ? "" : "nowrap"}" style="font-size:${state.terminalFontSize || 12.5}px;">${renderTerminalAnsi(state.surfaceDetail?.rawTerminalText || "")}</pre>`;
    return;
  }

  // If switching surface, dispose previous instance
  if (activeTerminalInstance && activeTerminalSurfaceId !== state.activeSurfaceId) {
    try {
      activeTerminalInstance.dispose();
    } catch {}
    activeTerminalInstance = null;
    activeTerminalFitAddon = null;
    activeTerminalSurfaceId = null;
    lastTerminalAnsiRendered = null;
  }

  if (!activeTerminalInstance) {
    container.innerHTML = "";
    const term = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: state.terminalFontSize || 12.5,
      lineHeight: 1.25,
      theme: {
        background: "#000000",
        foreground: "#E5E7EB",
        cursor: "#38BDF8",
        selectionBackground: "rgba(56, 189, 248, 0.3)",
        black: "#1E1E2E",
        red: "#F38BA8",
        green: "#A6E3A1",
        yellow: "#F9E2AF",
        blue: "#89B4FA",
        magenta: "#CBA6F7",
        cyan: "#89DCEB",
        white: "#CDD6F4",
        brightBlack: "#585B70",
        brightRed: "#F38BA8",
        brightGreen: "#A6E3A1",
        brightYellow: "#F9E2AF",
        brightBlue: "#89B4FA",
        brightMagenta: "#CBA6F7",
        brightCyan: "#89DCEB",
        brightWhite: "#BAC2DE",
      },
      scrollback: 2500,
      disableStdin: false,
    });

    const FitClass = window.FitAddon?.FitAddon || window.FitAddon;
    let fit = null;
    if (FitClass) {
      fit = new FitClass();
      term.loadAddon(fit);
    }

    term.open(container);
    if (fit) {
      try { fit.fit(); } catch {}
    }

    // Direct terminal typing from keyboard
    term.onData(async (data) => {
      if (!state.activeSurfaceId || !state.activeWorkspaceId) return;
      await apiPost({
        action: "send_prompt",
        workspaceId: state.activeWorkspaceId,
        surfaceId: state.activeSurfaceId,
        text: data,
        submit: false,
      });
    });

    activeTerminalInstance = term;
    activeTerminalFitAddon = fit;
    activeTerminalSurfaceId = state.activeSurfaceId;

    window.addEventListener("resize", () => {
      if (activeTerminalFitAddon) {
        try { activeTerminalFitAddon.fit(); } catch {}
      }
    });
  }

  // Update ANSI data
  if (rawAnsi && rawAnsi !== lastTerminalAnsiRendered) {
    activeTerminalInstance.clear();
    activeTerminalInstance.write(rawAnsi);
    lastTerminalAnsiRendered = rawAnsi;
    activeTerminalInstance.scrollToBottom();
    if (activeTerminalFitAddon) {
      try { activeTerminalFitAddon.fit(); } catch {}
    }
  }
}

function disposeXterm() {
  if (activeTerminalInstance) {
    try {
      activeTerminalInstance.dispose();
    } catch {}
    activeTerminalInstance = null;
    activeTerminalFitAddon = null;
    activeTerminalSurfaceId = null;
    lastTerminalAnsiRendered = null;
  }
}

window.copyTerminalText = function () {
  const raw =
    activeTerminalInstance?.getSelection() ||
    state.surfaceDetail?.rawTerminalText ||
    state.surfaceDetail?.cleanTerminalText ||
    "";
  if (navigator.clipboard && raw) {
    navigator.clipboard.writeText(raw).then(() => {
      hapticTick("medium");
      const btn = document.querySelector('[data-action="term-copy"]') || document.getElementById("copy-term-btn");
      if (btn) {
        const old = btn.textContent;
        btn.textContent = "✓ Copied";
        setTimeout(() => {
          btn.textContent = old;
        }, 1600);
      }
    });
  }
};

function renderMarkdown(md) {
  if (!md) return "";
  let text = escapeHtml(md);

  // Extract fenced code blocks first with syntax highlighting
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const cleanCode = code.trimEnd();
    const highlighted = highlightCode(cleanCode, lang);
    codeBlocks.push(
      `<div class="code-block-wrapper"><div class="code-header"><span>${escapeHtml(lang || "text")}</span><button class="copy-code-btn" onclick="copyCodeSnippet(this)">Copy</button></div><pre><code class="lang-${lang || "text"}">${highlighted}</code></pre></div>`
    );
    return `@@CODEBLOCK_${idx}@@`;
  });

  // Callout Alerts
  text = text.replace(
    /^(?:&gt;\s*)+\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([^\n]*)\n([\s\S]*?)(?=(?:\n{2,}|\n(?=[^&])|$))/gim,
    (_m, type, title, body) => {
      const t = type.toLowerCase();
      const icons = {
        note: "ℹ️ Note",
        tip: "💡 Tip",
        important: "⚡ Important",
        warning: "⚠️ Warning",
        caution: "🛑 Caution",
      };
      const cleanBody = body.replace(/^(?:&gt;\s*)+/gm, "").trim();
      return `<div class="callout-alert ${t}"><div class="callout-title">${icons[t] || type}${title ? `: ${title.trim()}` : ""}</div><div class="callout-body">${cleanBody}</div></div>`;
    }
  );

  // Markdown tables
  text = text.replace(/((?:^|\n)\|[^\n]+\|\n\|[-:\s|]+\|\n(?:\|[^\n]+\|\n?)+)/g, (match) => {
    const lines = match.trim().split("\n");
    if (lines.length < 3) return match;
    const headerCells = lines[0].split("|").slice(1, -1).map(c => `<th>${c.trim()}</th>`).join("");
    const bodyRows = lines.slice(2).map(row => {
      const cells = row.split("|").slice(1, -1).map(c => `<td>${c.trim()}</td>`).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    return `<div class="table-container"><table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  });

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Headings
  text = text.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  text = text.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Bold & Italic
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  // Bullet lists & Task Checkboxes
  text = text.replace(/^\s*[-*]\s+\[x\]\s+(.+)$/gm, '<li class="task-item checked"><span class="task-check">✓</span> <span>$1</span></li>');
  text = text.replace(/^\s*[-*]\s+\[ \]\s+(.+)$/gm, '<li class="task-item"><span class="task-check unchecked"></span> <span>$1</span></li>');
  text = text.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
  text = text.replace(/(<li[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
  text = text.replace(/<\/ul>\s*<ul>/g, "");

  // Paragraphs
  const blocks = text.split(/\n{2,}/);
  text = blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (
        t.startsWith("<h") ||
        t.startsWith("<ul") ||
        t.startsWith("<div") ||
        t.startsWith("@@CODEBLOCK_")
      ) {
        return t;
      }
      return `<p>${t.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  // Restore code blocks
  text = text.replace(/@@CODEBLOCK_(\d+)@@/g, (_m, i) => codeBlocks[Number(i)] || "");
  return text;
}

function shortenPath(p) {
  if (!p) return "";
  return p
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^~\/Library\/CloudStorage\/GoogleDrive-[^/]+\/My Drive/, "~/GDrive");
}

// WebSocket Connection Management
let ws = null;
let wsReconnectTimer = null;

function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    updateConnectionStatus(true);
    if (state.screen === "surface" && state.activeSurfaceId) {
      ws.send(
        JSON.stringify({
          type: "watch",
          workspaceId: state.activeWorkspaceId,
          surfaceId: state.activeSurfaceId,
        })
      );
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "dashboard" && msg.data) {
        const json = JSON.stringify(msg.data);
        if (json === state.dashboardJson) {
          return;
        }
        state.dashboardJson = json;
        state.dashboard = msg.data;
        saveCachedDashboard(msg.data);

        if (state.screen === "mission") {
          const vaultInp = document.getElementById("vault-search-input");
          const hadVaultFocus = document.activeElement === vaultInp;
          const vaultVal = vaultInp ? vaultInp.value : null;

          const container = document.getElementById("screen-container");
          if (container) {
            container.innerHTML = renderMissionControl();
            bindMissionEvents();
          }

          if (hadVaultFocus) {
            const nextInp = document.getElementById("vault-search-input");
            if (nextInp) {
              if (vaultVal !== null) nextInp.value = vaultVal;
              nextInp.focus();
            }
          }
        } else if (state.screen === "surface") {
          const wsObj = state.dashboard.workspaces?.find((w) => w.id === state.activeWorkspaceId);
          const surf = state.surfaceDetail?.surface || wsObj?.surfaces?.find((s) => s.id === state.activeSurfaceId);
          updateHeaderInPlace(wsObj, surf);
        }
      } else if (msg.type === "surface_detail" && msg.data) {
        if (msg.data.surface?.id === state.activeSurfaceId && state.screen === "surface") {
          const wasEmpty = !state.surfaceDetail;
          state.surfaceDetail = msg.data;
          state.surfaceLoading = false;
          if (wasEmpty) {
            state.viewMode = state.viewModeBySurface[state.activeSurfaceId] || msg.data.modeDefault || "agent";
            if (msg.data.markdownDocument) {
              state.docPreview = msg.data.markdownDocument;
            }
            const container = document.getElementById("screen-container");
            if (container) {
              container.innerHTML = renderSurfaceScreen();
              bindSurfaceEvents();
            }
            if (state.scrollBySurface[state.activeSurfaceId] === undefined) {
              scrollToViewportBottom();
            }
          } else {
            updateSurfaceInPlace(msg.data);
          }
        }
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    updateConnectionStatus(false);
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 1800);
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  };
}

function updateConnectionStatus(connected) {
  state.connected = connected;
  const banner = document.getElementById("offline-banner");
  if (banner) {
    banner.classList.toggle("visible", !connected);
  }
  const dot = document.querySelector("#mission-screen .nav-title .status-dot");
  if (dot) {
    dot.className = `status-dot ${connected ? "running" : "idle"}`;
  }
}

async function apiPost(body) {
  hapticTick();
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function openSurface(workspaceId, surfaceId, pushHistory = true) {
  // 1. Save state of previous surface before switching
  if (state.activeSurfaceId) {
    const vp = document.getElementById("surface-viewport");
    if (vp) state.scrollBySurface[state.activeSurfaceId] = vp.scrollTop;
    const ta = document.getElementById("composer-textarea");
    if (ta) state.draftsBySurface[state.activeSurfaceId] = ta.value;
    state.viewModeBySurface[state.activeSurfaceId] = state.viewMode;
  }

  hapticTick();
  state.screen = "surface";
  state.activeWorkspaceId = workspaceId;
  state.activeSurfaceId = surfaceId;
  state.surfaceLoading = true;
  state.surfaceDetail = null;
  state.gitDiffData = null;
  state.docPreview = null;

  // Restore saved composer draft and saved view mode for this surface
  state.composerText = state.draftsBySurface[surfaceId] || "";
  state.viewMode = state.viewModeBySurface[surfaceId] || "agent";

  if (pushHistory) {
    try {
      history.pushState(
        { screen: "surface", ws: workspaceId, surf: surfaceId },
        "",
        `#ws=${encodeURIComponent(workspaceId)}&surf=${encodeURIComponent(surfaceId)}`
      );
      localStorage.setItem(
        "cmux_orbit_last_view",
        JSON.stringify({ screen: "surface", ws: workspaceId, surf: surfaceId })
      );
    } catch {
      // ignore
    }
  }

  render();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "watch", workspaceId, surfaceId }));
  }

  try {
    const res = await fetch(
      `/api/surface?workspaceId=${encodeURIComponent(workspaceId)}&surfaceId=${encodeURIComponent(surfaceId)}`
    );
    const json = await res.json();
    if (json.ok && json.data) {
      state.surfaceDetail = json.data;
      if (!state.viewModeBySurface[surfaceId]) {
        state.viewMode = json.data.modeDefault || "agent";
      }
      if (json.data.markdownDocument) {
        state.docPreview = json.data.markdownDocument;
      }
    }
  } catch {
    // ignore
  } finally {
    state.surfaceLoading = false;
    render();
    if (state.scrollBySurface[surfaceId] !== undefined) {
      const vp = document.getElementById("surface-viewport");
      if (vp) vp.scrollTop = state.scrollBySurface[surfaceId];
    } else {
      scrollToViewportBottom();
    }
  }
}

function goHome(pushHistory = true) {
  if (state.activeSurfaceId) {
    const vp = document.getElementById("surface-viewport");
    if (vp) state.scrollBySurface[state.activeSurfaceId] = vp.scrollTop;
    const ta = document.getElementById("composer-textarea");
    if (ta) state.draftsBySurface[state.activeSurfaceId] = ta.value;
    state.viewModeBySurface[state.activeSurfaceId] = state.viewMode;
  }

  hapticTick();
  state.screen = "mission";
  state.activeSurfaceId = null;
  state.surfaceDetail = null;

  if (pushHistory) {
    try {
      history.pushState({ screen: "mission" }, "", "#");
      localStorage.setItem(
        "cmux_orbit_last_view",
        JSON.stringify({ screen: "mission" })
      );
    } catch {
      // ignore
    }
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "unwatch" }));
  }
  render();
}

async function loadGitDiff(cwd) {
  if (!cwd) return;
  state.gitDiffLoading = true;
  const vp = document.getElementById("surface-viewport");
  if (vp && state.viewMode === "diff") {
    vp.innerHTML = `<div class="workspace-card">Inspecting git status & diff…</div>`;
  }
  try {
    const res = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
    const json = await res.json();
    if (json.ok) {
      state.gitDiffData = json.data;
    }
  } catch {
    // ignore
  } finally {
    state.gitDiffLoading = false;
    if (vp && state.viewMode === "diff") {
      const ws = state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId);
      const surf = state.surfaceDetail?.surface || ws?.surfaces?.find((s) => s.id === state.activeSurfaceId);
      vp.innerHTML = renderSurfaceViewportContent(state.surfaceDetail, surf, ws);
      bindViewportEvents();
    }
  }
}

async function openFilePreview(filePath, cwd) {
  hapticTick();
  try {
    const res = await fetch(
      `/api/file?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd || "")}`
    );
    const json = await res.json();
    if (json.ok && json.data) {
      state.docPreview = json.data;
      state.viewMode = "markdown";
      const vp = document.getElementById("surface-viewport");
      if (vp) {
        const ws = state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId);
        const surf = state.surfaceDetail?.surface || ws?.surfaces?.find((s) => s.id === state.activeSurfaceId);
        vp.innerHTML = renderSurfaceViewportContent(state.surfaceDetail, surf, ws);
        bindViewportEvents();
        vp.scrollTop = 0;
      }
    }
  } catch {
    // ignore
  }
}

async function fetchVaultSessions(query = "") {
  try {
    const res = await fetch(`/api/vault?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    if (json.ok) {
      state.vaultResults = json.data || [];
      if (state.screen === "mission" && state.filter === "vault") {
        const container = document.getElementById("screen-container");
        if (container) {
          container.innerHTML = renderMissionControl();
          bindMissionEvents();
        }
      }
    }
  } catch {
    // ignore
  }
}

async function openVaultSessionModal(session) {
  hapticTick();
  state.vaultSelectedSession = session;
  state.vaultMessages = [];
  openModal("vault_preview");
  try {
    const res = await fetch(
      `/api/vault/transcript?file=${encodeURIComponent(session.file)}&agent=${encodeURIComponent(session.agent)}`
    );
    const json = await res.json();
    if (json.ok) {
      state.vaultMessages = json.data || [];
      if (state.activeModal === "vault_preview") {
        const root = document.getElementById("modal-root");
        if (root) {
          root.innerHTML = renderModal();
          bindModalEvents();
        }
      }
    }
  } catch {
    // ignore
  }
}

function scrollToViewportBottom() {
  requestAnimationFrame(() => {
    const vp = document.getElementById("surface-viewport");
    if (vp) {
      vp.scrollTop = vp.scrollHeight;
    }
  });
}

// Render Functions
function renderAgentBadge(agentKind) {
  const meta = AGENT_META[agentKind] || AGENT_META.shell;
  return `<span class="turn-author-badge">${meta.icon} ${meta.label}</span>`;
}

function renderMissionControl() {
  const dash = state.dashboard;
  if (!dash) {
    return `
      <div id="mission-screen" style="display:flex;flex-direction:column;min-height:100dvh;">
        <header class="top-nav">
          <div class="nav-title-group">
            <span class="nav-title"><span class="status-dot ${state.connected ? "running" : "idle"}"></span> Orbit</span>
            <span class="nav-subtitle">Connecting to cmux.sock on Mac…</span>
          </div>
        </header>
        <main class="content-area">
          <div class="workspace-card">Establishing bridge to cmux…</div>
        </main>
      </div>
    `;
  }

  const attentionList = dash.attentionItems || [];
  let workspaces = dash.workspaces || [];
  if (state.filter === "needs_input") {
    workspaces = workspaces.filter((w) => w.state === "needs_input");
  } else if (state.filter === "active") {
    workspaces = workspaces.filter(
      (w) => w.state === "running" || w.state === "unread" || w.hasUnread
    );
  }

  return `
    <div id="mission-screen" style="display:flex;flex-direction:column;min-height:100dvh;">
      <header class="top-nav">
        <div class="nav-title-group">
          <span class="nav-title">
            <span class="status-dot ${state.connected ? "running" : "idle"}"></span>
            Orbit
          </span>
          <span class="nav-subtitle">${dash.totalWorkspaces} workspaces · ${dash.totalSurfaces} surfaces</span>
        </div>
        <div class="nav-actions">
          <button class="btn-icon" data-action="refresh-dash" title="Refresh">↻</button>
          <button class="btn-icon primary" data-action="open-spawn" data-target="workspace">+ New</button>
        </div>
      </header>

      <nav class="segment-bar">
        <button class="segment-item ${state.filter === "all" ? "active" : ""}" data-filter="all">
          All (${dash.totalWorkspaces})
        </button>
        <button class="segment-item ${state.filter === "needs_input" ? "active" : ""}" data-filter="needs_input">
          Input${dash.needsInputCount > 0 ? ` (${dash.needsInputCount})` : ""}
        </button>
        <button class="segment-item ${state.filter === "active" ? "active" : ""}" data-filter="active">
          Active (${dash.runningCount + dash.unreadCount})
        </button>
        <button class="segment-item ${state.filter === "vault" ? "active" : ""}" data-filter="vault">
          Vault
        </button>
      </nav>

      <main class="content-area">
        ${
          state.filter === "vault"
            ? renderVaultView()
            : `
          ${
            attentionList.length > 0 && (state.filter === "all" || state.filter === "needs_input")
              ? `
            <div class="section-header" style="color:var(--status-amber);">⚡ ACTION REQUIRED (${attentionList.length})</div>
            ${attentionList
              .map(
                (item) => `
              <div class="attention-banner" data-open-ws="${item.workspaceId}" data-open-surf="${item.surfaceId}">
                <div class="attention-head">
                  <div class="attention-eyebrow">
                    <span class="status-dot needs_input"></span>
                    <span>Permission Request</span>
                  </div>
                  <span class="attention-tag">${escapeHtml(item.workspaceTitle)}</span>
                </div>
                <div class="attention-body">${escapeHtml(item.summary || item.surfaceTitle)}</div>
                <div class="attention-meta">
                  <span>${renderAgentBadge(item.agentKind)}</span>
                  <span>${escapeHtml(item.surfaceTitle)}</span>
                </div>
                <div class="attention-actions">
                  <button class="tui-btn primary" data-quick-key="1" data-ws="${item.workspaceId}" data-surf="${item.surfaceId}">
                    ✓ Allow (1)
                  </button>
                  <button class="tui-btn secondary" data-quick-key="escape" data-ws="${item.workspaceId}" data-surf="${item.surfaceId}">
                    ✕ Deny (Esc)
                  </button>
                  <button class="tui-btn ghost" data-open-ws="${item.workspaceId}" data-open-surf="${item.surfaceId}">
                    Inspect →
                  </button>
                </div>
              </div>
            `
              )
              .join("")}
          `
              : state.filter === "all"
              ? `
            <div class="zen-banner">
              <div class="zen-left">
                <span class="status-dot running"></span>
                <span>All Systems Operational</span>
              </div>
              <span class="zen-sub">${dash.runningCount} active · ${dash.totalWorkspaces} workspaces</span>
            </div>
          `
              : ""
          }

          <div class="section-header">Workspaces</div>

          ${workspaces
            .map((ws) => {
              const primarySurf = ws.surfaces.find((s) => s.isFocused) || ws.surfaces[0];
              return `
              <div class="workspace-card" data-open-ws="${ws.id}" data-open-surf="${primarySurf?.id || ""}">
                <div class="card-top">
                  <div class="ws-title-row">
                    <span class="status-dot ${ws.state}"></span>
                    <span class="ws-title">${escapeHtml(ws.title)}</span>
                  </div>
                  <span class="tab-badge">${ws.surfaces.length} tab${ws.surfaces.length === 1 ? "" : "s"}</span>
                </div>
                <div class="card-cwd">${escapeHtml(shortenPath(ws.cwd))}</div>
                ${ws.preview ? `<div class="card-snippet">${escapeHtml(ws.preview)}</div>` : ""}
              </div>
            `;
            })
            .join("")}
        `
        }
      </main>
    </div>
  `;
}

function renderVaultView() {
  return `
    <div style="display:flex;gap:8px;">
      <input
        id="vault-search-input"
        class="form-input"
        type="search"
        placeholder="Search past Claude, Grok, Codex sessions…"
        value="${escapeHtml(state.vaultQuery)}"
      />
      <button class="btn-icon primary" data-action="run-vault-search">Search</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
      ${state.vaultResults
        .map(
          (s) => `
        <div class="workspace-card" data-vault-idx="${escapeHtml(s.session_id)}">
          <div class="card-top">
            <span style="font-weight:600;font-size:14px;">${escapeHtml(s.title || s.session_id)}</span>
            <span class="tab-badge">${escapeHtml(s.agent)}</span>
          </div>
          <div class="card-cwd">${escapeHtml(shortenPath(s.cwd))} · ${(s.modified || "").slice(0, 16).replace("T", " ")}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderSurfaceTabs(ws) {
  if (!ws || !ws.surfaces || ws.surfaces.length <= 1) return "";
  return `
    ${ws.surfaces
      .map((s) => {
        const meta = AGENT_META[s.agentKind] || AGENT_META.shell;
        const isAct = s.id === state.activeSurfaceId;
        const dotState = isAct
          ? s.state
          : s.state === "needs_input"
          ? "needs_input"
          : s.hasUnread
          ? "unread"
          : "idle";
        return `
        <button class="surface-tab ${isAct ? "active" : ""}" data-open-ws="${ws.id}" data-open-surf="${s.id}" title="${escapeHtml(s.title)}">
          <span class="status-dot ${dotState}"></span>
          <span>${meta.icon}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.title)}</span>
        </button>
      `;
      })
      .join("")}
    <button class="surface-tab" data-action="open-spawn" data-target="surface">+ Tab</button>
  `;
}

function renderSurfaceScreen() {
  const dash = state.dashboard;
  const ws =
    dash?.workspaces?.find((w) => w.id === state.activeWorkspaceId) ||
    dash?.workspaces?.find((w) =>
      w.surfaces.some((s) => s.id === state.activeSurfaceId)
    );
  const detail = state.surfaceDetail;
  const surf =
    detail?.surface ||
    ws?.surfaces?.find((s) => s.id === state.activeSurfaceId);

  const prompt = detail?.detectedPrompt;
  const isRunning = surf?.state === "running";

  return `
    <div class="surface-screen" style="display:flex;flex-direction:column;height:100dvh;overflow:hidden;">
      <header class="top-nav">
        <button class="btn-icon" data-action="go-home">‹ Deck</button>
        <button class="nav-title-group" style="background:none;border:none;cursor:pointer;text-align:left;flex:1;margin:0 4px;min-width:0;" data-action="open-ws-switcher">
          <span class="nav-title">
            <span id="header-ws-dot" class="status-dot ${ws?.state || "idle"}"></span>
            <span id="header-ws-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ws?.title || "Workspace")}</span>
            <span style="font-size:11px;color:var(--text-muted);flex-shrink:0;">▾</span>
          </span>
          <span id="header-subtitle" class="nav-subtitle" style="max-width:260px;">${escapeHtml(surf?.title || "")} · ${escapeHtml(shortenPath(surf?.cwd || ws?.cwd || ""))}</span>
        </button>
        <div class="nav-actions">
          <button class="btn-pill ${state.viewMode === "diff" ? "active" : ""}" data-mode="diff">± Diff</button>
          <button class="btn-icon ${state.viewMode === "terminal" ? "active" : ""}" data-mode="terminal" id="cli-peek-btn" title="Toggle CLI">&gt;_</button>
          <button class="btn-icon" data-action="open-telemetry" title="Telemetry">ⓘ</button>
        </div>
      </header>

      <nav id="surface-tabs-container" class="surface-tabs" style="${ws && ws.surfaces && ws.surfaces.length > 1 ? "" : "display:none;"}">
        ${renderSurfaceTabs(ws)}
      </nav>

      <main id="surface-viewport" class="${state.viewMode === "terminal" ? "terminal-view" : state.viewMode === "diff" ? "diff-view" : "conversation-stream"}">
        ${renderSurfaceViewportContent(detail, surf, ws)}
      </main>

      ${state.viewMode !== "terminal" ? `
        <button id="jump-bottom-btn" class="jump-bottom-btn" onclick="scrollToViewportBottom()">
          ${isRunning ? `<span class="status-dot running" style="width:6px;height:6px;"></span> ` : ""}↓ Latest
        </button>
      ` : ""}

      <div id="tui-prompt-dock-container">
        ${prompt ? renderTuiPromptDeck(prompt, ws?.id, surf?.id) : ""}
      </div>

      ${state.viewMode === "terminal" ? `
        <footer class="terminal-dock" id="terminal-dock">
          <div class="terminal-keys-row">
            <button class="term-key-btn sigint" data-action="term-key" data-key="ctrl+c" title="Interrupt process (SIGINT)">^C</button>
            <button class="term-key-btn" data-action="term-key" data-key="esc" title="Escape">Esc</button>
            <button class="term-key-btn" data-action="term-key" data-key="tab" title="Tab Autocomplete">Tab</button>
            <button class="term-key-btn" data-action="term-key" data-key="up" title="Previous Command">↑</button>
            <button class="term-key-btn" data-action="term-key" data-key="down" title="Next Command">↓</button>
            <button class="term-key-btn" data-action="term-key" data-key="enter" title="Enter">↵</button>
            <button class="term-key-btn" data-action="term-clear" title="Clear Screen">Clear</button>
            <button class="term-key-btn" data-action="term-copy" title="Copy Output">Copy</button>
            <button class="term-key-btn" data-action="font-dec" title="Smaller font">A-</button>
            <button class="term-key-btn" data-action="font-inc" title="Larger font">A+</button>
          </div>
          <form id="terminal-command-form" class="terminal-command-row">
            <span class="terminal-prompt-glyph">$</span>
            <input
              type="text"
              id="terminal-command-input"
              class="terminal-command-input"
              placeholder="Type shell command (e.g. ls -la, git status, cargo test)…"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
            />
            <button type="submit" class="terminal-send-btn" id="terminal-send-btn">↵ Run</button>
          </form>
        </footer>
      ` : `
        <footer class="composer-dock" id="composer-dock">
          <div class="composer-shell">
            <button class="composer-tool-btn" data-action="open-shortcuts" title="Signals & Shortcuts">···</button>
            <button class="composer-tool-btn" data-action="toggle-composer-mode" title="Toggle Ask vs Shell" style="font-size:13px;font-family:var(--font-mono);font-weight:700;">
              ${state.composerMode === "shell" ? "$" : "✦"}
            </button>
            <textarea
              id="composer-textarea"
              class="composer-input"
              rows="1"
              autocorrect="off"
              autocapitalize="sentences"
              spellcheck="true"
              placeholder="${
                state.composerMode === "shell"
                  ? "Run shell command (! or raw)…"
                  : `Message ${AGENT_META[surf?.agentKind]?.label || "surface"}…`
              }"
            >${escapeHtml(state.composerText)}</textarea>
            <button class="composer-send-btn" data-action="submit-composer">↑</button>
          </div>
        </footer>
      `}
    </div>
  `;
}

function cleanToolSummary(summary) {
  if (!summary) return "";
  let s = String(summary).trim();
  s = s.replace(/-Users-[a-zA-Z0-9_.-]+-Library-CloudStorage-GoogleDrive-[a-zA-Z0-9_.-]+-M\b/g, ".../Testing Life OS");
  s = s.replace(/^\/Users\/[^/]+/g, "~");
  if (s.length > 70) {
    s = s.slice(0, 68) + "…";
  }
  return s;
}

function renderGroupedToolCalls(toolCalls, turnKey = "t0") {
  if (!toolCalls || toolCalls.length === 0) return "";
  if (toolCalls.length === 1) {
    const tc = toolCalls[0];
    const detailsId = `tool-single-${turnKey}-${tc.name}`;
    const isOpen = state.openDetails.has(detailsId);
    return `
      <details class="tool-call-row" data-details-id="${escapeHtml(detailsId)}" ${isOpen ? "open" : ""}>
        <summary class="tool-call-summary">
          <div style="display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">
            <span>⚡</span>
            <span style="font-weight:650;color:var(--accent-blue);flex-shrink:0;">${escapeHtml(tc.name)}:</span>
            <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(cleanToolSummary(tc.summary))}</span>
          </div>
          <span class="chevron">▾</span>
        </summary>
        <div class="tool-call-body">
          ${tc.output ? `<div>${escapeHtml(tc.output)}</div>` : `<div style="color:var(--text-muted);">Executed successfully.</div>`}
        </div>
      </details>
    `;
  }

  const groupKey = `tool-group-${turnKey}`;
  const isGroupOpen = state.openDetails.has(groupKey);
  const types = Array.from(new Set(toolCalls.map((t) => t.name))).join(", ");
  return `
    <details class="tool-call-group" data-details-id="${escapeHtml(groupKey)}" ${isGroupOpen ? "open" : ""}>
      <summary class="tool-group-summary">
        <div class="tool-group-left">
          <span>⚡</span>
          <span style="font-weight:600;color:var(--text-primary);">${toolCalls.length} tool calls</span>
          <span class="tool-types-pill">${escapeHtml(types)}</span>
        </div>
        <span class="chevron">▾</span>
      </summary>
      <div class="tool-group-list">
        ${toolCalls
          .map(
            (tc) => `
          <div class="tool-sub-item">
            <div class="tool-sub-head">
              <span class="tool-badge-small">${escapeHtml(tc.name)}</span>
              <span class="tool-sub-summary">${escapeHtml(cleanToolSummary(tc.summary))}</span>
            </div>
            ${tc.output ? `<pre class="tool-sub-output">${escapeHtml(tc.output)}</pre>` : ""}
          </div>
        `
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderSurfaceViewportContent(detail, surf, ws) {
  if (state.surfaceLoading && !detail) {
    return `<div class="workspace-card">Connecting to surface stream…</div>`;
  }

  if (state.viewMode === "markdown") {
    const doc = state.docPreview || detail?.markdownDocument;
    if (!doc) {
      return `<div class="workspace-card">No markdown document selected.</div>`;
    }
    return `
      <div class="turn-assistant">
        <div class="turn-author">
          <span>📄 ${escapeHtml(doc.name)}</span>
          <span class="turn-author-badge">${escapeHtml(shortenPath(doc.path))}</span>
        </div>
        <div class="prose">${renderMarkdown(doc.content)}</div>
      </div>
    `;
  }

  if (state.viewMode === "diff") {
    if (state.gitDiffLoading) {
      return `<div class="workspace-card">Inspecting git status & diff…</div>`;
    }
    const git = state.gitDiffData;
    if (!git || !git.isGitRepo) {
      return `<div class="workspace-card">Not a Git repository (${escapeHtml(surf?.cwd || ws?.cwd || "")})</div>`;
    }
    return `
      <div class="workspace-card">
        <div class="card-top">
          <span style="font-weight:650;">⎇ ${escapeHtml(git.branch || "HEAD")}</span>
          <span class="diff-stats">
            <span class="diff-add">+${git.totalAdditions}</span>
            <span class="diff-del">-${git.totalDeletions}</span>
          </span>
        </div>
        <div class="card-cwd">${escapeHtml(shortenPath(git.cwd))} · ${git.files.length} changed files</div>
      </div>
      ${
        git.files.length === 0
          ? `<div class="workspace-card">✓ Working tree is clean.</div>`
          : git.files
              .map(
                (f) => `
          <div class="diff-card">
            <div class="diff-card-header">
              <span>[${escapeHtml(f.status)}] ${escapeHtml(f.path)}</span>
              <span class="diff-stats">
                <span class="diff-add">+${f.additions}</span>
                <span class="diff-del">-${f.deletions}</span>
              </span>
            </div>
            ${f.patch ? `<pre class="diff-patch">${formatDiffPatch(f.patch)}</pre>` : ""}
          </div>
        `
              )
              .join("")
      }
    `;
  }

  if (state.viewMode === "terminal") {
    return `
      <div id="xterm-container" class="xterm-fullscreen-container">
        <noscript>
          <pre class="terminal-box ${state.terminalWrap ? "" : "nowrap"}" style="font-size:${state.terminalFontSize || 12.5}px;">${renderTerminalAnsi(detail?.rawTerminalText || "")}</pre>
        </noscript>
      </div>
    `;
  }

  // Agent Dialogue Stream View
  const messages = detail?.messages || [];
  const detectedFiles = detail?.detectedFiles || [];
  const liveSnippet = detail?.liveProseSnippet || "";
  const agentMeta = AGENT_META[surf?.agentKind] || AGENT_META.shell;

  return `
    ${
      detectedFiles.length > 0
        ? `
      <div class="surface-tabs" style="border-bottom:none;padding-top:0;">
        ${detectedFiles
          .map((fp) => {
            const name = fp.split("/").pop();
            return `<button class="surface-tab" data-preview-file="${escapeHtml(fp)}" data-cwd="${escapeHtml(surf?.cwd || ws?.cwd || "")}">📄 ${escapeHtml(name)}</button>`;
          })
          .join("")}
      </div>
    `
        : ""
    }

    ${
      messages.length === 0
        ? `
      <div class="turn-assistant">
        <div class="turn-author">
          <span>${agentMeta.icon} ${agentMeta.label}</span>
          <span class="turn-author-badge">Live</span>
        </div>
        <div class="prose">
          <p>Showing live reflowed stream for <strong>${escapeHtml(surf?.title || "")}</strong>.</p>
        </div>
      </div>
    `
        : messages
            .map((m, mIdx) => {
              if (m.role === "user") {
                return `<div class="turn-user">${escapeHtml(m.text)}</div>`;
              }
              const turnKey = m.timestamp ? m.timestamp.replace(/[^a-zA-Z0-9_-]/g, "_") : `turn-${mIdx}`;
              const reasoningKey = `reasoning-${turnKey}`;
              const isReasoningOpen = state.openDetails.has(reasoningKey);
              return `
          <div class="turn-assistant">
            <div class="turn-author">
              <span>${agentMeta.icon} ${escapeHtml(m.model || agentMeta.label)}</span>
              <span class="turn-author-badge">${escapeHtml((m.timestamp || "").slice(11, 19))}</span>
            </div>
            ${
              m.thinking
                ? `
              <details class="tool-call-row" data-details-id="${escapeHtml(reasoningKey)}" ${isReasoningOpen ? "open" : ""}>
                <summary class="tool-call-summary">
                  <span>💭 Reasoning</span>
                  <span class="chevron">▾</span>
                </summary>
                <div class="tool-call-body">${escapeHtml(m.thinking)}</div>
              </details>
            `
                : ""
            }
            ${
              m.toolCalls && m.toolCalls.length > 0
                ? renderGroupedToolCalls(m.toolCalls, turnKey)
                : ""
            }
            ${m.text ? `<div class="prose">${renderMarkdown(m.text)}</div>` : ""}
          </div>
        `;
            })
            .join("")
    }

    ${
      messages.length === 0 && liveSnippet
        ? `
      <div class="workspace-card" style="margin-top:8px;">
        <div class="card-top" style="margin-bottom:4px;">
          <span style="font-size:11px;font-weight:600;color:var(--accent-blue);">● LIVE TERMINAL BUFFER</span>
          <button class="btn-icon" style="height:24px;font-size:11px;" data-mode="terminal">Full CLI →</button>
        </div>
        <pre class="terminal-box" style="min-height:auto;max-height:160px;margin:0;padding:8px;font-size:11.5px;">${renderTerminalAnsi(liveSnippet)}</pre>
      </div>
    `
        : surf?.state === "running"
        ? `
      <div class="live-activity-bar">
        <div class="live-activity-left">
          <span class="status-dot running"></span>
          <span>Agent executing tools & generation…</span>
        </div>
        <button class="btn-icon" data-mode="terminal" style="height:26px;font-size:11.5px;padding:0 8px;">&gt;_ CLI</button>
      </div>
    `
        : ""
    }
  `;
}

function formatDiffPatch(patch) {
  return patch
    .split("\n")
    .map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return `<span class="diff-line-add">${esc}</span>`;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return `<span class="diff-line-del">${esc}</span>`;
      }
      if (line.startsWith("@@")) {
        return `<span class="diff-line-hunk">${esc}</span>`;
      }
      return esc + "\n";
    })
    .join("");
}

function renderTuiPromptDeck(prompt, workspaceId, surfaceId) {
  return `
    <aside class="tui-prompt-dock">
      <div class="tui-prompt-title">⚡ ${escapeHtml(prompt.title)}</div>
      ${prompt.subtitle ? `<div class="tui-prompt-subtitle">${escapeHtml(prompt.subtitle)}</div>` : ""}
      <div class="tui-prompt-buttons">
        ${prompt.options
          .map(
            (opt) => `
          <button
            class="tui-btn ${opt.style || "secondary"}"
            data-answer-key="${escapeHtml(opt.key)}"
            data-ws="${escapeHtml(workspaceId || "")}"
            data-surf="${escapeHtml(surfaceId || "")}"
          >
            ${opt.index && prompt.kind === "numbered" ? `${opt.index}. ` : ""}${escapeHtml(opt.label)}
          </button>
        `
          )
          .join("")}
      </div>
    </aside>
  `;
}

function renderModal() {
  if (!state.activeModal) return "";

  if (state.activeModal === "shortcuts") {
    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>Signals & Shortcuts</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>
          <div class="form-label">Process Signals</div>
          <div class="shortcut-grid">
            <button class="shortcut-btn" style="color:var(--status-coral);border-color:rgba(248,113,113,0.3);" data-send-key="ctrl+c">^C Kill</button>
            <button class="shortcut-btn" data-send-key="escape">Esc</button>
            <button class="shortcut-btn" data-send-key="enter">↵ Return</button>
            <button class="shortcut-btn" data-send-key="tab">Tab</button>
            <button class="shortcut-btn" data-send-key="shift+tab">⇧Tab</button>
            <button class="shortcut-btn" data-send-key="up">↑ Prev</button>
            <button class="shortcut-btn" data-send-key="down">↓ Next</button>
            <button class="shortcut-btn" data-send-key="space">Space</button>
          </div>
          <div class="form-label" style="margin-top:6px;">Agent Slash Commands</div>
          <div class="shortcut-grid">
            <button class="shortcut-btn slash" data-insert-slash="/status">/status</button>
            <button class="shortcut-btn slash" data-insert-slash="/compact">/compact</button>
            <button class="shortcut-btn slash" data-insert-slash="/resume">/resume</button>
            <button class="shortcut-btn slash" data-insert-slash="/model">/model</button>
          </div>
        </div>
      </div>
    `;
  }

  if (state.activeModal === "telemetry") {
    const telem = state.surfaceDetail?.telemetry || {};
    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>Session Telemetry</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>
          <div class="telemetry-grid">
            <div class="telemetry-item">
              <span class="telemetry-label">Model</span>
              <span class="telemetry-val">${escapeHtml(telem.model || "—")}</span>
            </div>
            <div class="telemetry-item">
              <span class="telemetry-label">Context Used</span>
              <span class="telemetry-val">${escapeHtml(telem.contextPercent || "—")}</span>
            </div>
            <div class="telemetry-item">
              <span class="telemetry-label">Cost (Session)</span>
              <span class="telemetry-val">${escapeHtml(telem.costSession || "—")}</span>
            </div>
            <div class="telemetry-item">
              <span class="telemetry-label">Cost (Today)</span>
              <span class="telemetry-val">${escapeHtml(telem.costToday || "—")}</span>
            </div>
            <div class="telemetry-item">
              <span class="telemetry-label">Permission</span>
              <span class="telemetry-val">${escapeHtml(telem.permissionMode || "Normal")}</span>
            </div>
            <div class="telemetry-item">
              <span class="telemetry-label">Token Rate</span>
              <span class="telemetry-val">${escapeHtml(telem.tokenSpeed || "—")}</span>
            </div>
          </div>
          ${
            telem.subagents && telem.subagents.length > 0
              ? `
            <div class="form-label" style="margin-top:6px;">Active Subagents (${telem.subagents.length})</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${telem.subagents
                .map(
                  (sa) => `
                <div class="workspace-card" style="padding:10px 12px;">
                  <div class="card-top">
                    <span style="font-weight:600;font-size:13px;">${escapeHtml(sa.id)}</span>
                    <span class="tab-badge">${escapeHtml(sa.status)}</span>
                  </div>
                </div>
              `
                )
                .join("")}
            </div>
          `
              : ""
          }
        </div>
      </div>
    `;
  }

  if (state.activeModal === "ws_switcher") {
    const workspaces = state.dashboard?.workspaces || [];
    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>Workspaces</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${workspaces
              .map((w) => {
                const isCurrentWs = w.id === state.activeWorkspaceId;
                const primary = w.surfaces.find((s) => s.isFocused) || w.surfaces[0];
                return `
                <div class="workspace-card ${isCurrentWs ? "active" : ""}" data-open-ws="${w.id}" data-open-surf="${primary?.id || ""}">
                  <div class="card-top">
                    <div class="ws-title-row">
                      <span class="status-dot ${w.state}"></span>
                      <span class="ws-title" style="${isCurrentWs ? "color:#FFFFFF;font-weight:700;" : ""}">${escapeHtml(w.title)}</span>
                      ${isCurrentWs ? `<span class="turn-author-badge" style="color:var(--accent-blue);background:rgba(56,189,248,0.12);">CURRENT</span>` : ""}
                    </div>
                    <span class="tab-badge">${w.surfaces.length} tab${w.surfaces.length === 1 ? "" : "s"}</span>
                  </div>
                  <div class="card-cwd">${escapeHtml(shortenPath(w.cwd))}</div>
                  ${
                    w.surfaces.length > 1
                      ? `
                    <div style="display:flex;gap:6px;overflow-x:auto;padding-top:4px;">
                      ${w.surfaces.map(s => `
                        <button class="surface-tab ${s.id === state.activeSurfaceId ? "active" : ""}" data-open-ws="${w.id}" data-open-surf="${s.id}" style="height:24px;font-size:11px;">
                          ${AGENT_META[s.agentKind]?.icon || ">_"} ${escapeHtml(s.title)}
                        </button>
                      `).join("")}
                    </div>
                  `
                      : ""
                  }
                </div>
              `;
              })
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  if (state.activeModal === "spawn") {
    const dirs = state.dashboard?.recentDirectories || [];
    const sf = state.spawnForm;
    const presets = [
      { id: "claude", label: "✦ Claude Code", cmd: "claude", desc: "Anthropic CLI agent" },
      { id: "grok", label: "𝕏 Grok CLI", cmd: "grok", desc: "xAI deep research & code" },
      { id: "codex", label: "⚡ Codex", cmd: "codex", desc: "OpenAI reasoning agent" },
      { id: "pi", label: "π Pi Agent", cmd: "pi", desc: "Lightweight coding harness" },
      { id: "agy", label: "▲ Antigravity", cmd: "ag", desc: "Deepmind agentic coding" },
      { id: "shell", label: ">_ Shell", cmd: "", desc: "Standard zsh terminal" },
    ];

    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>${sf.target === "workspace" ? "Spawn Workspace" : "Spawn Surface Tab"}</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>

          <div class="preset-grid">
            ${presets
              .map(
                (p) => `
              <button class="preset-btn ${sf.preset === p.id ? "selected" : ""}" data-spawn-preset="${p.id}" data-spawn-cmd="${p.cmd}">
                <span style="font-weight:650;font-size:13.5px;color:var(--text-primary);">${p.label}</span>
                <span style="font-size:11px;color:var(--text-muted);">${p.desc}</span>
              </button>
            `
              )
              .join("")}
          </div>

          <div>
            <div class="form-label" style="margin-bottom:6px;">Working Directory</div>
            <input id="spawn-cwd" class="form-input" value="${escapeHtml(sf.cwd)}" placeholder="/Users/felix/Projects/..." />
            <div style="display:flex;gap:6px;overflow-x:auto;margin-top:6px;">
              ${dirs
                .map(
                  (d) =>
                    `<button class="btn-pill" data-pick-dir="${escapeHtml(d.path)}">${escapeHtml(d.label)}</button>`
                )
                .join("")}
            </div>
          </div>

          <div>
            <div class="form-label" style="margin-bottom:6px;">Title (Optional)</div>
            <input id="spawn-title" class="form-input" value="${escapeHtml(sf.title)}" placeholder="e.g. Auth Refactor" />
          </div>

          <div>
            <div class="form-label" style="margin-bottom:6px;">Initial Prompt (Optional)</div>
            <input id="spawn-prompt" class="form-input" value="${escapeHtml(sf.initialPrompt)}" placeholder="Kick off instruction immediately…" />
          </div>

          <button class="btn-icon primary" style="width:100%;height:44px;font-size:15px;margin-top:4px;" data-action="confirm-spawn">
            Launch ${sf.preset.toUpperCase()} →
          </button>
        </div>
      </div>
    `;
  }

  if (state.activeModal === "vault_preview" && state.vaultSelectedSession) {
    const s = state.vaultSelectedSession;
    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>${escapeHtml(s.title || s.session_id)}</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>
          <div class="card-cwd">${escapeHtml(shortenPath(s.cwd))} · ${escapeHtml(s.agent)}</div>
          <div style="display:flex;flex-direction:column;gap:12px;max-height:60dvh;overflow-y:auto;">
            ${
              state.vaultMessages.length === 0
                ? `<div class="workspace-card">Loading transcript turns…</div>`
                : state.vaultMessages
                    .map((m) =>
                      m.role === "user"
                        ? `<div class="turn-user">${escapeHtml(m.text)}</div>`
                        : `<div class="turn-assistant"><div class="prose">${renderMarkdown(m.text)}</div></div>`
                    )
                    .join("")
            }
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

function render() {
  const container = document.getElementById("screen-container");
  if (!container) return;

  const prevVp = document.getElementById("surface-viewport");
  const prevScrollTop = prevVp ? prevVp.scrollTop : null;
  const wasNearBottom =
    prevVp && prevVp.scrollHeight - prevVp.scrollTop - prevVp.clientHeight < 80;

  const activeTextarea = document.getElementById("composer-textarea");
  const hadFocus = document.activeElement === activeTextarea;
  if (activeTextarea && state.activeSurfaceId) {
    state.composerText = activeTextarea.value;
    state.draftsBySurface[state.activeSurfaceId] = activeTextarea.value;
  }

  if (state.screen === "surface") {
    container.innerHTML = renderSurfaceScreen();
    bindSurfaceEvents();

    const nextVp = document.getElementById("surface-viewport");
    if (nextVp) {
      const savedScroll = state.activeSurfaceId ? state.scrollBySurface[state.activeSurfaceId] : null;
      if (savedScroll !== null && savedScroll !== undefined) {
        nextVp.scrollTop = savedScroll;
      } else if (prevScrollTop !== null) {
        nextVp.scrollTop = wasNearBottom ? nextVp.scrollHeight : prevScrollTop;
      }
    }

    const nextTextarea = document.getElementById("composer-textarea");
    if (nextTextarea && hadFocus) {
      nextTextarea.focus();
      nextTextarea.selectionStart = nextTextarea.selectionEnd = nextTextarea.value.length;
    }

    const activeTab = document.querySelector(".surface-tab.active");
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }

    if (state.viewMode === "terminal") {
      ensureXtermMounted(state.surfaceDetail?.rawTerminalAnsi || state.surfaceDetail?.rawTerminalText);
    } else {
      disposeXterm();
    }
  } else {
    disposeXterm();
    container.innerHTML = renderMissionControl();
    bindMissionEvents();
  }

  // Update modal root
  const modalRoot = document.getElementById("modal-root");
  if (modalRoot) {
    if (state.activeModal) {
      modalRoot.innerHTML = renderModal();
      bindModalEvents();
    } else {
      modalRoot.innerHTML = "";
    }
  }

  // Update offline banner
  const banner = document.getElementById("offline-banner");
  if (banner) {
    banner.classList.toggle("visible", !state.connected);
  }
}

function updateSurfaceInPlace(detail) {
  if (state.screen !== "surface" || !detail) return;
  if (detail.surface?.id !== state.activeSurfaceId) return;

  state.surfaceDetail = detail;
  state.surfaceLoading = false;

  const ws = state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId);
  const surf = detail.surface || ws?.surfaces?.find((s) => s.id === state.activeSurfaceId);

  // 1. Header Dot, Title, and Subtitle
  const dot = document.getElementById("header-ws-dot");
  if (dot && ws) {
    dot.className = `status-dot ${ws.state || "idle"}`;
  }
  const title = document.getElementById("header-ws-title");
  if (title && ws?.title) {
    title.textContent = ws.title;
  }
  const sub = document.getElementById("header-subtitle");
  if (sub && surf) {
    sub.textContent = `${surf.title || ""} · ${shortenPath(surf.cwd || ws?.cwd || "")}`;
  }

  // 2. Surface Tabs
  const tabsContainer = document.getElementById("surface-tabs-container");
  if (tabsContainer && ws) {
    if (ws.surfaces && ws.surfaces.length > 1) {
      tabsContainer.style.display = "";
      const tabsHtml = renderSurfaceTabs(ws);
      if (tabsContainer.innerHTML !== tabsHtml) {
        tabsContainer.innerHTML = tabsHtml;
        bindTabsEvents();
      }
    } else {
      tabsContainer.style.display = "none";
    }
  }

  // 3. Jump Bottom Button Running Dot
  const jumpBtn = document.getElementById("jump-bottom-btn");
  if (jumpBtn) {
    const isRunning = surf?.state === "running";
    jumpBtn.innerHTML = `${isRunning ? '<span class="status-dot running" style="width:6px;height:6px;"></span> ' : ""}↓ Latest`;
  }

  // 4. TUI Prompt Dock
  const promptContainer = document.getElementById("tui-prompt-dock-container");
  if (promptContainer) {
    const newPromptHtml = detail.detectedPrompt
      ? renderTuiPromptDeck(detail.detectedPrompt, ws?.id, surf?.id)
      : "";
    if (promptContainer.innerHTML.trim() !== newPromptHtml.trim()) {
      promptContainer.innerHTML = newPromptHtml;
      bindPromptEvents();
    }
  }

  // 5. Surface Viewport Content
  const vp = document.getElementById("surface-viewport");
  if (vp) {
    if (state.viewMode === "terminal") {
      ensureXtermMounted(detail.rawTerminalAnsi || detail.rawTerminalText);
    } else {
      const newContentHtml = renderSurfaceViewportContent(detail, surf, ws);
      if (vp.innerHTML !== newContentHtml) {
        const isNearBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80;
        const prevScrollTop = vp.scrollTop;

        vp.innerHTML = newContentHtml;

        if (isNearBottom) {
          vp.scrollTop = vp.scrollHeight;
        } else {
          vp.scrollTop = prevScrollTop;
        }

        bindViewportEvents();
      }
    }
  }
  // Composer textarea and buttons are completely preserved without redraw!
}

function updateHeaderInPlace(ws, surf) {
  const dot = document.getElementById("header-ws-dot");
  if (dot && ws) {
    dot.className = `status-dot ${ws.state || "idle"}`;
  }
  const title = document.getElementById("header-ws-title");
  if (title && ws?.title) {
    title.textContent = ws.title;
  }
  const sub = document.getElementById("header-subtitle");
  if (sub && surf) {
    sub.textContent = `${surf.title || ""} · ${shortenPath(surf.cwd || ws?.cwd || "")}`;
  }
  const tabsContainer = document.getElementById("surface-tabs-container");
  if (tabsContainer && ws) {
    if (ws.surfaces && ws.surfaces.length > 1) {
      tabsContainer.style.display = "";
      const tabsHtml = renderSurfaceTabs(ws);
      if (tabsContainer.innerHTML !== tabsHtml) {
        tabsContainer.innerHTML = tabsHtml;
        bindTabsEvents();
      }
    } else {
      tabsContainer.style.display = "none";
    }
  }
}

function openModal(modalName, options = {}) {
  hapticTick();
  state.activeModal = modalName;
  if (modalName === "spawn") {
    const target = options.target || "surface";
    const currentWs = state.dashboard?.workspaces?.find(
      (w) => w.id === state.activeWorkspaceId
    );
    state.spawnForm.target = target;
    state.spawnForm.cwd =
      options.cwd ||
      state.surfaceDetail?.surface?.cwd ||
      currentWs?.cwd ||
      state.dashboard?.recentDirectories?.[0]?.path ||
      "/Users/felix/Projects";
  }

  const root = document.getElementById("modal-root");
  if (root) {
    root.innerHTML = renderModal();
    bindModalEvents();
  }
}

function closeModal() {
  state.activeModal = null;
  const root = document.getElementById("modal-root");
  if (root) {
    root.innerHTML = "";
  }
}

function bindMissionEvents() {
  // Filter segment items
  document.querySelectorAll("[data-filter]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.filter = el.getAttribute("data-filter");
      if (state.filter === "vault" && state.vaultResults.length === 0) {
        fetchVaultSessions(state.vaultQuery);
      }
      const container = document.getElementById("screen-container");
      if (container) {
        container.innerHTML = renderMissionControl();
        bindMissionEvents();
      }
    });
  });

  // Attention banner quick inline actions
  document.querySelectorAll("[data-quick-key]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = el.getAttribute("data-quick-key");
      const workspaceId = el.getAttribute("data-ws");
      const surfaceId = el.getAttribute("data-surf");
      hapticTick("medium");

      const banner = el.closest(".attention-banner");
      if (banner) {
        banner.querySelectorAll("button").forEach((b) => {
          b.disabled = true;
          b.style.opacity = "0.4";
        });
        el.style.opacity = "1";
        el.textContent = "✓ Approved";
        setTimeout(() => {
          banner.style.transition = "transform 180ms ease, opacity 180ms ease";
          banner.style.transform = "translateY(-8px) scale(0.97)";
          banner.style.opacity = "0";
        }, 160);
      }

      await apiPost({ action: "answer_prompt", workspaceId, surfaceId, key });
    });
  });

  // Open workspace / surface
  document.querySelectorAll("[data-open-surf]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wsId = el.getAttribute("data-open-ws");
      const surfId = el.getAttribute("data-open-surf");
      if (surfId) openSurface(wsId, surfId);
    });
  });

  // Action buttons on mission screen
  document.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const act = el.getAttribute("data-action");
      if (act === "refresh-dash") {
        hapticTick();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "refresh" }));
        }
      } else if (act === "open-spawn") {
        const target = el.getAttribute("data-target") || "workspace";
        openModal("spawn", { target });
      } else if (act === "run-vault-search") {
        const inp = document.getElementById("vault-search-input");
        state.vaultQuery = inp ? inp.value : "";
        fetchVaultSessions(state.vaultQuery);
      }
    });
  });

  // Vault input search on Enter
  const vInp = document.getElementById("vault-search-input");
  if (vInp) {
    vInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        state.vaultQuery = vInp.value;
        fetchVaultSessions(state.vaultQuery);
      }
    });
  }

  // Vault item click
  document.querySelectorAll("[data-vault-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      const sid = el.getAttribute("data-vault-idx");
      const found = state.vaultResults.find((x) => x.session_id === sid);
      if (found) openVaultSessionModal(found);
    });
  });
}

function bindSurfaceEvents() {
  const goHomeBtn = document.querySelector("[data-action='go-home']");
  if (goHomeBtn) goHomeBtn.addEventListener("click", () => goHome());

  const wsSwitcherBtn = document.querySelector("[data-action='open-ws-switcher']");
  if (wsSwitcherBtn) wsSwitcherBtn.addEventListener("click", () => openModal("ws_switcher"));

  const telemBtn = document.querySelector("[data-action='open-telemetry']");
  if (telemBtn) telemBtn.addEventListener("click", () => openModal("telemetry"));

  // Mode switcher tabs (Diff, Terminal, Agent)
  document.querySelectorAll("[data-mode]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      let m = el.getAttribute("data-mode");
      if (m === "terminal" && state.viewMode === "terminal") {
        m = "agent";
      }
      state.viewMode = m;
      if (state.activeSurfaceId) {
        state.viewModeBySurface[state.activeSurfaceId] = m;
      }
      if (m === "diff") {
        const cwd =
          state.surfaceDetail?.surface?.cwd ||
          state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId)?.cwd;
        loadGitDiff(cwd);
      }
      render();
    });
  });

  // Press-and-Hold X-Ray Peek on CLI button
  const cliBtn = document.getElementById("cli-peek-btn");
  if (cliBtn) {
    let holdTimer = null;
    cliBtn.addEventListener("pointerdown", () => {
      if (state.viewMode !== "terminal") {
        holdTimer = setTimeout(() => {
          hapticTick();
          state.peekModePrev = state.viewMode;
          state.viewMode = "terminal";
          render();
        }, 260);
      }
    });
    const endHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (state.peekModePrev) {
        state.viewMode = state.peekModePrev;
        state.peekModePrev = null;
        render();
      }
    };
    cliBtn.addEventListener("pointerup", endHold);
    cliBtn.addEventListener("pointercancel", endHold);
  }

  bindTabsEvents();
  bindPromptEvents();
  bindViewportEvents();
  if (state.viewMode === "terminal") {
    bindTerminalDockEvents();
  } else {
    bindComposerEvents();
  }
}

function bindTabsEvents() {
  const tabsContainer = document.getElementById("surface-tabs-container");
  if (!tabsContainer) return;

  tabsContainer.querySelectorAll("[data-open-surf]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wsId = el.getAttribute("data-open-ws");
      const surfId = el.getAttribute("data-open-surf");
      if (surfId && surfId !== state.activeSurfaceId) {
        openSurface(wsId, surfId);
      }
    });
  });

  tabsContainer.querySelectorAll("[data-action='open-spawn']").forEach((el) => {
    el.addEventListener("click", () => {
      openModal("spawn", { target: "surface" });
    });
  });
}

function bindPromptEvents() {
  const dock = document.getElementById("tui-prompt-dock-container");
  if (!dock) return;

  dock.querySelectorAll("[data-answer-key]").forEach((el) => {
    el.addEventListener("click", async () => {
      const key = el.getAttribute("data-answer-key");
      const workspaceId = el.getAttribute("data-ws");
      const surfaceId = el.getAttribute("data-surf");
      hapticTick("medium");

      dock.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
        b.style.opacity = "0.45";
      });
      el.style.opacity = "1";
      el.innerHTML = "✓ " + el.innerHTML;

      await apiPost({ action: "answer_prompt", workspaceId, surfaceId, key });
      if (state.surfaceDetail?.detectedPrompt) {
        state.surfaceDetail.detectedPrompt = null;
        setTimeout(() => {
          dock.innerHTML = "";
        }, 220);
      }
    });
  });
}

function bindViewportEvents() {
  const vp = document.getElementById("surface-viewport");
  if (!vp) return;

  vp.onscroll = () => {
    if (state.activeSurfaceId) {
      state.scrollBySurface[state.activeSurfaceId] = vp.scrollTop;
    }
    const isUp = vp.scrollHeight - vp.scrollTop - vp.clientHeight > 200;
    const btn = document.getElementById("jump-bottom-btn");
    if (btn) btn.classList.toggle("visible", isUp);
  };

  vp.ontouchmove = () => {
    const ta = document.getElementById("composer-textarea");
    if (ta && document.activeElement === ta) {
      ta.blur();
    }
  };

  let touchStartX = 0;
  let touchStartY = 0;
  vp.ontouchstart = (e) => {
    if (e.changedTouches?.length) {
      touchStartX = e.changedTouches[0].clientX;
      touchStartY = e.changedTouches[0].clientY;
    }
  };

  vp.ontouchend = (e) => {
    if (e.changedTouches?.length) {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;

      // Edge swipe from left bezel (touchStartX < 40px) returns to Deck!
      if (touchStartX < 40 && dx > 80 && Math.abs(dy) < 50) {
        hapticTick();
        goHome();
        return;
      }

      // Horizontal swipe across surfaces in this workspace
      if (Math.abs(dx) > 70 && Math.abs(dy) < 45) {
        const currentWs = state.dashboard?.workspaces?.find(
          (w) => w.id === state.activeWorkspaceId
        );
        if (currentWs && currentWs.surfaces.length > 1) {
          const idx = currentWs.surfaces.findIndex(
            (s) => s.id === state.activeSurfaceId
          );
          if (idx !== -1) {
            if (dx < 0 && idx < currentWs.surfaces.length - 1) {
              hapticTick();
              openSurface(currentWs.id, currentWs.surfaces[idx + 1].id);
            } else if (dx > 0 && idx > 0) {
              hapticTick();
              openSurface(currentWs.id, currentWs.surfaces[idx - 1].id);
            }
          }
        }
      }
    }
  };

  // Detected file preview chips
  vp.querySelectorAll("[data-preview-file]").forEach((el) => {
    el.addEventListener("click", () => {
      const fp = el.getAttribute("data-preview-file");
      const cwd = el.getAttribute("data-cwd");
      openFilePreview(fp, cwd);
    });
  });

  // Terminal actions in viewport
  vp.querySelectorAll("[data-action='toggle-wrap']").forEach((el) => {
    el.addEventListener("click", () => {
      state.terminalWrap = !state.terminalWrap;
      const box = vp.querySelector(".terminal-box");
      if (box) box.classList.toggle("nowrap", !state.terminalWrap);
      el.textContent = state.terminalWrap ? "⇄ Reflow" : "→ Scroll";
    });
  });

  vp.querySelectorAll("[data-action='font-dec']").forEach((el) => {
    el.addEventListener("click", () => {
      state.terminalFontSize = Math.max(9.5, state.terminalFontSize - 1);
      const box = vp.querySelector(".terminal-box");
      if (box) box.style.fontSize = `${state.terminalFontSize}px`;
    });
  });

  vp.querySelectorAll("[data-action='font-inc']").forEach((el) => {
    el.addEventListener("click", () => {
      state.terminalFontSize = Math.min(18, state.terminalFontSize + 1);
      const box = vp.querySelector(".terminal-box");
      if (box) box.style.fontSize = `${state.terminalFontSize}px`;
    });
  });
}

function bindComposerEvents() {
  const dock = document.getElementById("composer-dock");
  if (!dock) return;

  const shortcutsBtn = dock.querySelector("[data-action='open-shortcuts']");
  if (shortcutsBtn) shortcutsBtn.addEventListener("click", () => openModal("shortcuts"));

  const toggleModeBtn = dock.querySelector("[data-action='toggle-composer-mode']");
  if (toggleModeBtn) {
    toggleModeBtn.addEventListener("click", () => {
      hapticTick();
      state.composerMode = state.composerMode === "ask" ? "shell" : "ask";
      toggleModeBtn.textContent = state.composerMode === "shell" ? "$" : "✦";
      const ta = document.getElementById("composer-textarea");
      if (ta) {
        ta.placeholder =
          state.composerMode === "shell"
            ? "Run shell command (! or raw)…"
            : `Message ${AGENT_META[state.surfaceDetail?.surface?.agentKind]?.label || "surface"}…`;
      }
    });
  }

  const sendBtn = dock.querySelector("[data-action='submit-composer']");
  if (sendBtn) {
    sendBtn.addEventListener("click", () => submitComposer());
  }

  const ta = document.getElementById("composer-textarea");
  if (ta) {
    ta.addEventListener("input", () => {
      state.composerText = ta.value;
      if (state.activeSurfaceId) {
        state.draftsBySurface[state.activeSurfaceId] = ta.value;
      }
      ta.style.height = "auto";
      ta.style.height = Math.min(110, ta.scrollHeight) + "px";
    });
    ta.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        await submitComposer();
      }
    });
  }
}

function bindTerminalDockEvents() {
  const dock = document.getElementById("terminal-dock");
  if (!dock) return;

  dock.querySelectorAll('[data-action="term-key"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const key = btn.getAttribute("data-key");
      if (!key || !state.activeSurfaceId || !state.activeWorkspaceId) return;
      hapticTick("medium");
      await apiPost({
        action: "send_key",
        workspaceId: state.activeWorkspaceId,
        surfaceId: state.activeSurfaceId,
        key,
      });
    });
  });

  dock.querySelectorAll('[data-action="term-clear"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      hapticTick();
      if (activeTerminalInstance) {
        activeTerminalInstance.clear();
      }
    });
  });

  dock.querySelectorAll('[data-action="term-copy"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      copyTerminalText();
    });
  });

  dock.querySelectorAll('[data-action="font-dec"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      state.terminalFontSize = Math.max(9.5, (state.terminalFontSize || 12.5) - 1);
      if (activeTerminalInstance) {
        activeTerminalInstance.options.fontSize = state.terminalFontSize;
        try { activeTerminalFitAddon?.fit(); } catch {}
      }
    });
  });

  dock.querySelectorAll('[data-action="font-inc"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      state.terminalFontSize = Math.min(20, (state.terminalFontSize || 12.5) + 1);
      if (activeTerminalInstance) {
        activeTerminalInstance.options.fontSize = state.terminalFontSize;
        try { activeTerminalFitAddon?.fit(); } catch {}
      }
    });
  });

  const form = document.getElementById("terminal-command-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("terminal-command-input");
      if (!input) return;
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = "";
      hapticTick("medium");
      await apiPost({
        action: "send_prompt",
        workspaceId: state.activeWorkspaceId,
        surfaceId: state.activeSurfaceId,
        text: cmd,
        submit: true,
      });
    });
  }
}

function bindModalEvents() {
  const root = document.getElementById("modal-root");
  if (!root) return;

  root.querySelectorAll("[data-action='close-modal']").forEach((el) => {
    el.addEventListener("click", () => closeModal());
  });

  root.querySelectorAll("[data-spawn-preset]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.preset = el.getAttribute("data-spawn-preset");
      state.spawnForm.command = el.getAttribute("data-spawn-cmd") || "";
      root.innerHTML = renderModal();
      bindModalEvents();
    });
  });

  root.querySelectorAll("[data-pick-dir]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.cwd = el.getAttribute("data-pick-dir");
      const cwdInp = document.getElementById("spawn-cwd");
      if (cwdInp) cwdInp.value = state.spawnForm.cwd;
    });
  });

  root.querySelectorAll("[data-action='confirm-spawn']").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      await submitSpawn();
    });
  });

  root.querySelectorAll("[data-send-key]").forEach((el) => {
    el.addEventListener("click", async () => {
      const key = el.getAttribute("data-send-key");
      hapticTick("medium");
      await apiPost({
        action: "send_key",
        workspaceId: state.activeWorkspaceId,
        surfaceId: state.activeSurfaceId,
        key,
      });
      closeModal();
    });
  });

  root.querySelectorAll("[data-insert-slash]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick("light");
      const cmd = el.getAttribute("data-insert-slash");
      closeModal();
      setTimeout(() => {
        const nextTa = document.getElementById("composer-textarea");
        if (nextTa) {
          nextTa.value = cmd + " ";
          state.composerText = nextTa.value;
          if (state.activeSurfaceId) {
            state.draftsBySurface[state.activeSurfaceId] = nextTa.value;
          }
          nextTa.focus();
        }
      }, 50);
    });
  });

  root.querySelectorAll("[data-open-surf]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wsId = el.getAttribute("data-open-ws");
      const surfId = el.getAttribute("data-open-surf");
      closeModal();
      if (surfId) openSurface(wsId, surfId);
    });
  });
}

// Global toggle capture listener to persist open details accordions across background updates
document.addEventListener(
  "toggle",
  (e) => {
    const el = e.target;
    if (el && el.matches && el.matches("details[data-details-id]")) {
      const id = el.getAttribute("data-details-id");
      if (id) {
        if (el.open) {
          state.openDetails.add(id);
        } else {
          state.openDetails.delete(id);
        }
      }
    }
  },
  true
);

async function submitComposer() {
  const ta = document.getElementById("composer-textarea");
  const raw = (ta ? ta.value : state.composerText).trim();
  if (!raw || !state.activeSurfaceId) return;

  const textToSend =
    state.composerMode === "shell" &&
    state.surfaceDetail?.surface?.agentKind === "claude" &&
    !raw.startsWith("!")
      ? `! ${raw}`
      : raw;

  state.composerText = "";
  if (state.activeSurfaceId) {
    delete state.draftsBySurface[state.activeSurfaceId];
  }
  if (ta) {
    ta.value = "";
    ta.style.height = "auto";
  }

  // Optimistic feedback: append user turn immediately to stream
  const vp = document.getElementById("surface-viewport");
  if (vp && state.viewMode === "agent") {
    const userDiv = document.createElement("div");
    userDiv.className = "turn-user";
    userDiv.textContent = raw;
    vp.appendChild(userDiv);
    vp.scrollTop = vp.scrollHeight;
  }

  await apiPost({
    action: "send_prompt",
    workspaceId: state.activeWorkspaceId,
    surfaceId: state.activeSurfaceId,
    text: textToSend,
    submit: true,
  });
}

async function submitSpawn() {
  const cwdInp = document.getElementById("spawn-cwd");
  const titleInp = document.getElementById("spawn-title");
  const promptInp = document.getElementById("spawn-prompt");

  const cwd = cwdInp ? cwdInp.value.trim() : state.spawnForm.cwd;
  const title = titleInp ? titleInp.value.trim() : state.spawnForm.title;
  const initialPrompt = promptInp ? promptInp.value.trim() : state.spawnForm.initialPrompt;
  const command = state.spawnForm.command;

  closeModal();

  if (state.spawnForm.target === "workspace" || !state.activeWorkspaceId) {
    await apiPost({
      action: "spawn_workspace",
      cwd,
      title: title || `${state.spawnForm.preset} · ${cwd.split("/").pop()}`,
      command,
      initialPrompt,
    });
  } else {
    await apiPost({
      action: "spawn_surface",
      workspaceId: state.activeWorkspaceId,
      cwd,
      title: title || state.spawnForm.preset,
      command,
      initialPrompt,
    });
  }
}

function initNavigationState() {
  window.addEventListener("popstate", (e) => {
    if (e.state && e.state.screen === "surface" && e.state.ws && e.state.surf) {
      openSurface(e.state.ws, e.state.surf, false);
    } else {
      goHome(false);
    }
  });

  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const hashWs = params.get("ws");
  const hashSurf = params.get("surf");

  if (hashWs && hashSurf) {
    openSurface(hashWs, hashSurf, false);
    return;
  }

  try {
    const last = JSON.parse(localStorage.getItem("cmux_orbit_last_view") || "{}");
    if (last.screen === "surface" && last.ws && last.surf) {
      openSurface(last.ws, last.surf, false);
    }
  } catch {
    // ignore
  }
}

// Dynamic iOS Visual Viewport Keyboard Adjustment
if (window.visualViewport) {
  const onViewportChange = () => {
    const vv = window.visualViewport;
    const isKeyboardOpen = window.innerHeight - vv.height > 120;
    document.documentElement.style.setProperty(
      "--composer-safe-bottom",
      isKeyboardOpen ? "4px" : "env(safe-area-inset-bottom, 0px)"
    );
  };
  window.visualViewport.addEventListener("resize", onViewportChange);
  window.visualViewport.addEventListener("scroll", onViewportChange);
}

// Register Service Worker & Start App
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

initNavigationState();
render();
connectWebSocket();
