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
    if (navigator.vibrate) navigator.vibrate(8);
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

window.copyTerminalText = function () {
  const raw = state.surfaceDetail?.rawTerminalText || "";
  if (navigator.clipboard && raw) {
    navigator.clipboard.writeText(raw).then(() => {
      hapticTick("medium");
      const btn = document.getElementById("copy-term-btn");
      if (btn) {
        btn.textContent = "✓ Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
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
    state.connected = true;
    if (state.screen === "surface" && state.activeSurfaceId) {
      ws.send(
        JSON.stringify({
          type: "watch",
          workspaceId: state.activeWorkspaceId,
          surfaceId: state.activeSurfaceId,
        })
      );
    }
    render();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "dashboard" && msg.data) {
        state.dashboard = msg.data;
        saveCachedDashboard(msg.data);
        render();
      } else if (msg.type === "surface_detail" && msg.data) {
        if (msg.data.surface?.id === state.activeSurfaceId) {
          const wasEmpty = !state.surfaceDetail;
          state.surfaceDetail = msg.data;
          state.surfaceLoading = false;
          if (wasEmpty) {
            state.viewMode = msg.data.modeDefault || "agent";
            if (msg.data.markdownDocument) {
              state.docPreview = msg.data.markdownDocument;
            }
          }
          render();
          if (wasEmpty) scrollToViewportBottom();
        }
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    state.connected = false;
    render();
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

async function apiPost(body) {
  hapticTick();
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function openSurface(workspaceId, surfaceId) {
  hapticTick();
  state.screen = "surface";
  state.activeWorkspaceId = workspaceId;
  state.activeSurfaceId = surfaceId;
  state.surfaceLoading = true;
  state.surfaceDetail = null;
  state.gitDiffData = null;
  state.docPreview = null;
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
      state.viewMode = json.data.modeDefault || "agent";
      if (json.data.markdownDocument) {
        state.docPreview = json.data.markdownDocument;
      }
    }
  } catch {
    // ignore
  } finally {
    state.surfaceLoading = false;
    render();
    scrollToViewportBottom();
  }
}

function goHome() {
  hapticTick();
  state.screen = "mission";
  state.activeSurfaceId = null;
  state.surfaceDetail = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "unwatch" }));
  }
  render();
}

async function loadGitDiff(cwd) {
  if (!cwd) return;
  state.gitDiffLoading = true;
  render();
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
    render();
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
      render();
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
      render();
    }
  } catch {
    // ignore
  }
}

async function openVaultSessionModal(session) {
  hapticTick();
  state.vaultSelectedSession = session;
  state.vaultMessages = [];
  state.activeModal = "vault_preview";
  render();
  try {
    const res = await fetch(
      `/api/vault/transcript?file=${encodeURIComponent(session.file)}&agent=${encodeURIComponent(session.agent)}`
    );
    const json = await res.json();
    if (json.ok) {
      state.vaultMessages = json.data || [];
      render();
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
      <header class="top-nav">
        <div class="nav-title-group">
          <span class="nav-title"><span class="status-dot ${state.connected ? "running" : "idle"}"></span> Orbit</span>
          <span class="nav-subtitle">Connecting to cmux.sock on Mac…</span>
        </div>
      </header>
      <main class="content-area">
        <div class="workspace-card">Establishing bridge to cmux…</div>
      </main>
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
          ${attentionList
            .map(
              (item) => `
            <div class="attention-banner" data-open-ws="${item.workspaceId}" data-open-surf="${item.surfaceId}">
              <div class="attention-head">
                <span>⚡ Needs Your Input</span>
                <span>${escapeHtml(item.workspaceTitle)}</span>
              </div>
              <div class="attention-body">${escapeHtml(item.summary || item.surfaceTitle)}</div>
              <div class="attention-meta">${escapeHtml(item.surfaceTitle)} · ${item.agentKind.toUpperCase()}</div>
              <div style="display:flex;gap:8px;margin-top:6px;">
                <button class="tui-btn primary" data-open-ws="${item.workspaceId}" data-open-surf="${item.surfaceId}">
                  Respond →
                </button>
                <button class="tui-btn secondary" data-quick-key="1" data-ws="${item.workspaceId}" data-surf="${item.surfaceId}">
                  ✓ Yes (1)
                </button>
              </div>
            </div>
          `
            )
            .join("")}
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

  return `
    <div class="surface-screen" style="display:flex;flex-direction:column;height:100dvh;overflow:hidden;">
      <header class="top-nav">
        <button class="btn-icon" data-action="go-home">‹ Deck</button>
        <button class="nav-title-group" style="background:none;border:none;cursor:pointer;text-align:left;flex:1;margin:0 4px;" data-action="open-ws-switcher">
          <span class="nav-title">
            <span class="status-dot ${ws?.state || "idle"}"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ws?.title || "Workspace")}</span>
            <span style="font-size:11px;color:var(--text-muted);flex-shrink:0;">▾</span>
          </span>
          <span class="nav-subtitle">${escapeHtml(surf?.title || "")} · ${escapeHtml(shortenPath(surf?.cwd || ws?.cwd || ""))}</span>
        </button>
        <div class="nav-actions">
          <button class="btn-pill ${state.viewMode === "diff" ? "active" : ""}" data-mode="diff">± Diff</button>
          <button class="btn-icon ${state.viewMode === "terminal" ? "active" : ""}" data-mode="terminal" id="cli-peek-btn" title="Toggle CLI">&gt;_</button>
          <button class="btn-icon" data-action="open-telemetry" title="Telemetry">ⓘ</button>
        </div>
      </header>

      ${
        ws && ws.surfaces && ws.surfaces.length > 1
          ? `
        <nav class="surface-tabs">
          ${ws.surfaces
            .map((s) => {
              const meta = AGENT_META[s.agentKind] || AGENT_META.shell;
              const isAct = s.id === state.activeSurfaceId;
              return `
              <button class="surface-tab ${isAct ? "active" : ""}" data-open-ws="${ws.id}" data-open-surf="${s.id}">
                <span class="status-dot ${s.state}"></span>
                <span>${meta.icon}</span>
                <span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.title)}</span>
              </button>
            `;
            })
            .join("")}
          <button class="surface-tab" data-action="open-spawn" data-target="surface">+ Tab</button>
        </nav>
      `
          : ""
      }

      <main id="surface-viewport" class="${state.viewMode === "terminal" ? "terminal-view" : state.viewMode === "diff" ? "diff-view" : "conversation-stream"}">
        ${renderSurfaceViewportContent(detail, surf, ws)}
      </main>

      <button id="jump-bottom-btn" class="jump-bottom-btn" onclick="scrollToViewportBottom()">↓ Bottom</button>

      ${prompt ? renderTuiPromptDeck(prompt, ws?.id, surf?.id) : ""}

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
    </div>
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
    const rawText = detail?.rawTerminalText || "No terminal buffer output.";
    return `
      <div class="terminal-header-bar">
        <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${escapeHtml(surf?.title || "Terminal")}</span>
        <div style="display:flex;gap:6px;">
          <button class="btn-icon" id="copy-term-btn" onclick="copyTerminalText()">Copy</button>
          <button class="btn-icon" data-action="toggle-wrap">${state.terminalWrap ? "⇄ Reflow" : "→ Scroll"}</button>
          <button class="btn-icon" data-action="font-dec">A-</button>
          <button class="btn-icon" data-action="font-inc">A+</button>
        </div>
      </div>
      <pre class="terminal-box ${state.terminalWrap ? "" : "nowrap"}" style="font-size:${state.terminalFontSize}px;">${renderTerminalAnsi(rawText)}</pre>
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
            .map((m) => {
              if (m.role === "user") {
                return `<div class="turn-user">${escapeHtml(m.text)}</div>`;
              }
              return `
          <div class="turn-assistant">
            <div class="turn-author">
              <span>${agentMeta.icon} ${escapeHtml(m.model || agentMeta.label)}</span>
              <span class="turn-author-badge">${escapeHtml((m.timestamp || "").slice(11, 19))}</span>
            </div>
            ${
              m.thinking
                ? `
              <details class="tool-call-row">
                <summary class="tool-call-summary">
                  <span>💭 Reasoning</span>
                  <span style="font-size:10px;">▾</span>
                </summary>
                <div class="tool-call-body">${escapeHtml(m.thinking)}</div>
              </details>
            `
                : ""
            }
            ${
              m.toolCalls && m.toolCalls.length > 0
                ? m.toolCalls
                    .map(
                      (tc) => `
                <details class="tool-call-row">
                  <summary class="tool-call-summary">
                    <span>⚡ ${escapeHtml(tc.name)}</span>
                    <span style="font-size:10px;">▾</span>
                  </summary>
                  <div class="tool-call-body">
                    <div style="font-weight:600;margin-bottom:4px;color:var(--text-primary);">${escapeHtml(tc.summary)}</div>
                    ${tc.output ? `<div>${escapeHtml(tc.output)}</div>` : ""}
                  </div>
                </details>
              `
                    )
                    .join("")
                : ""
            }
            ${m.text ? `<div class="prose">${renderMarkdown(m.text)}</div>` : ""}
          </div>
        `;
            })
            .join("")
    }

    ${
      liveSnippet
        ? `
      <div class="workspace-card" style="margin-top:8px;">
        <div class="card-top" style="margin-bottom:4px;">
          <span style="font-size:11px;font-weight:600;color:var(--accent-blue);">● LIVE TERMINAL TAIL</span>
          <button class="btn-icon" style="height:24px;font-size:11px;" data-mode="terminal">Full CLI →</button>
        </div>
        <pre class="terminal-box" style="min-height:auto;max-height:160px;margin:0;padding:8px;font-size:11.5px;">${renderTerminalAnsi(liveSnippet)}</pre>
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
            <button class="shortcut-btn" data-send-key="ctrl+c">^C</button>
            <button class="shortcut-btn" data-send-key="escape">Esc</button>
            <button class="shortcut-btn" data-send-key="tab">Tab</button>
            <button class="shortcut-btn" data-send-key="shift+tab">⇧Tab</button>
            <button class="shortcut-btn" data-send-key="up">↑</button>
            <button class="shortcut-btn" data-send-key="down">↓</button>
            <button class="shortcut-btn" data-send-key="space">Space</button>
            <button class="shortcut-btn" data-send-key="enter">↵ Enter</button>
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
            <span>Switch Workspace</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${workspaces
              .map((w) => {
                const primary = w.surfaces.find((s) => s.isFocused) || w.surfaces[0];
                return `
                <div class="workspace-card" data-open-ws="${w.id}" data-open-surf="${primary?.id || ""}">
                  <div class="card-top">
                    <div class="ws-title-row">
                      <span class="status-dot ${w.state}"></span>
                      <span class="ws-title">${escapeHtml(w.title)}</span>
                    </div>
                    <span class="tab-badge">${w.surfaces.length} tab${w.surfaces.length === 1 ? "" : "s"}</span>
                  </div>
                  <div class="card-cwd">${escapeHtml(shortenPath(w.cwd))}</div>
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
  const app = document.getElementById("app");
  if (!app) return;

  const prevVp = document.getElementById("surface-viewport");
  const prevScrollTop = prevVp ? prevVp.scrollTop : null;
  const wasNearBottom =
    prevVp && prevVp.scrollHeight - prevVp.scrollTop - prevVp.clientHeight < 80;

  const activeTextarea = document.getElementById("composer-textarea");
  const hadFocus = document.activeElement === activeTextarea;
  if (activeTextarea) {
    state.composerText = activeTextarea.value;
  }

  const offlineHtml = `<div id="offline-banner" class="offline-banner ${state.connected ? "" : "visible"}">⚠️ Reconnecting to Mac…</div>`;

  app.innerHTML =
    offlineHtml +
    (state.screen === "surface" ? renderSurfaceScreen() : renderMissionControl()) +
    renderModal();

  const nextVp = document.getElementById("surface-viewport");
  if (nextVp && prevScrollTop !== null) {
    nextVp.scrollTop = wasNearBottom ? nextVp.scrollHeight : prevScrollTop;
  }

  const nextTextarea = document.getElementById("composer-textarea");
  if (nextTextarea && hadFocus) {
    nextTextarea.focus();
    nextTextarea.selectionStart = nextTextarea.selectionEnd = nextTextarea.value.length;
  }

  bindEvents();
}

function bindEvents() {
  // Open workspace/surface
  document.querySelectorAll("[data-open-surf]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wsId = el.getAttribute("data-open-ws");
      const surfId = el.getAttribute("data-open-surf");
      state.activeModal = null;
      if (surfId) openSurface(wsId, surfId);
    });
  });

  // Quick inline actions on Mission Control cards
  document.querySelectorAll("[data-quick-key]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = el.getAttribute("data-quick-key");
      const workspaceId = el.getAttribute("data-ws");
      const surfaceId = el.getAttribute("data-surf");
      await apiPost({ action: "answer_prompt", workspaceId, surfaceId, key });
    });
  });

  // Filter segment items
  document.querySelectorAll("[data-filter]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.filter = el.getAttribute("data-filter");
      if (state.filter === "vault" && state.vaultResults.length === 0) {
        fetchVaultSessions(state.vaultQuery);
      }
      render();
    });
  });

  // Mode switcher tabs
  document.querySelectorAll("[data-mode]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      const m = el.getAttribute("data-mode");
      state.viewMode = m;
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

  // Detected file preview chips
  document.querySelectorAll("[data-preview-file]").forEach((el) => {
    el.addEventListener("click", () => {
      const fp = el.getAttribute("data-preview-file");
      const cwd = el.getAttribute("data-cwd");
      openFilePreview(fp, cwd);
    });
  });

  // TUI Prompt Option Buttons
  document.querySelectorAll("[data-answer-key]").forEach((el) => {
    el.addEventListener("click", async () => {
      const key = el.getAttribute("data-answer-key");
      const workspaceId = el.getAttribute("data-ws");
      const surfaceId = el.getAttribute("data-surf");
      hapticTick("medium");

      const dock = el.closest(".tui-prompt-dock");
      if (dock) {
        dock.querySelectorAll("button").forEach((b) => {
          b.disabled = true;
          b.style.opacity = "0.45";
        });
        el.style.opacity = "1";
        el.innerHTML = "✓ " + el.innerHTML;
      }

      await apiPost({ action: "answer_prompt", workspaceId, surfaceId, key });
      if (state.surfaceDetail?.detectedPrompt) {
        state.surfaceDetail.detectedPrompt = null;
        setTimeout(() => render(), 220);
      }
    });
  });

  // Viewport interactions: Jump to bottom, swipe across surfaces, dismiss keyboard
  const vp = document.getElementById("surface-viewport");
  if (vp) {
    vp.addEventListener(
      "scroll",
      () => {
        const isUp = vp.scrollHeight - vp.scrollTop - vp.clientHeight > 200;
        const btn = document.getElementById("jump-bottom-btn");
        if (btn) btn.classList.toggle("visible", isUp);
      },
      { passive: true }
    );

    vp.addEventListener(
      "touchmove",
      () => {
        const ta = document.getElementById("composer-textarea");
        if (ta && document.activeElement === ta) {
          ta.blur();
        }
      },
      { passive: true }
    );

    let touchStartX = 0;
    let touchStartY = 0;
    vp.addEventListener(
      "touchstart",
      (e) => {
        if (e.changedTouches?.length) {
          touchStartX = e.changedTouches[0].clientX;
          touchStartY = e.changedTouches[0].clientY;
        }
      },
      { passive: true }
    );

    vp.addEventListener(
      "touchend",
      (e) => {
        if (e.changedTouches?.length) {
          const dx = e.changedTouches[0].clientX - touchStartX;
          const dy = e.changedTouches[0].clientY - touchStartY;
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
      },
      { passive: true }
    );
  }

  // Key Strip / Shortcut Buttons
  document.querySelectorAll("[data-send-key]").forEach((el) => {
    el.addEventListener("click", async () => {
      const key = el.getAttribute("data-send-key");
      await apiPost({
        action: "send_key",
        workspaceId: state.activeWorkspaceId,
        surfaceId: state.activeSurfaceId,
        key,
      });
      state.activeModal = null;
      render();
    });
  });

  document.querySelectorAll("[data-insert-slash]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      const cmd = el.getAttribute("data-insert-slash");
      const ta = document.getElementById("composer-textarea");
      state.activeModal = null;
      render();
      setTimeout(() => {
        const nextTa = document.getElementById("composer-textarea");
        if (nextTa) {
          nextTa.value = cmd + " ";
          state.composerText = nextTa.value;
          nextTa.focus();
        }
      }, 50);
    });
  });

  // General data-action buttons
  document.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const act = el.getAttribute("data-action");
      if (act === "go-home") {
        goHome();
      } else if (act === "refresh-dash") {
        hapticTick();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "refresh" }));
        }
      } else if (act === "open-ws-switcher") {
        hapticTick();
        state.activeModal = "ws_switcher";
        render();
      } else if (act === "open-shortcuts") {
        hapticTick();
        state.activeModal = "shortcuts";
        render();
      } else if (act === "open-telemetry") {
        hapticTick();
        state.activeModal = "telemetry";
        render();
      } else if (act === "open-spawn") {
        hapticTick();
        const target = el.getAttribute("data-target") || "surface";
        const currentWs = state.dashboard?.workspaces?.find(
          (w) => w.id === state.activeWorkspaceId
        );
        state.spawnForm.target = target;
        state.spawnForm.cwd =
          state.surfaceDetail?.surface?.cwd ||
          currentWs?.cwd ||
          state.dashboard?.recentDirectories?.[0]?.path ||
          "/Users/felix/Projects";
        state.activeModal = "spawn";
        render();
      } else if (act === "close-modal") {
        state.activeModal = null;
        render();
      } else if (act === "toggle-composer-mode") {
        hapticTick();
        state.composerMode = state.composerMode === "ask" ? "shell" : "ask";
        render();
      } else if (act === "toggle-wrap") {
        state.terminalWrap = !state.terminalWrap;
        render();
      } else if (act === "font-dec") {
        state.terminalFontSize = Math.max(9.5, state.terminalFontSize - 1);
        render();
      } else if (act === "font-inc") {
        state.terminalFontSize = Math.min(18, state.terminalFontSize + 1);
        render();
      } else if (act === "submit-composer") {
        await submitComposer();
      } else if (act === "confirm-spawn") {
        e.stopPropagation();
        await submitSpawn();
      } else if (act === "run-vault-search") {
        const inp = document.getElementById("vault-search-input");
        state.vaultQuery = inp ? inp.value : "";
        await fetchVaultSessions(state.vaultQuery);
      }
    });
  });

  // Spawn modal preset & directory pickers
  document.querySelectorAll("[data-spawn-preset]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.preset = el.getAttribute("data-spawn-preset");
      state.spawnForm.command = el.getAttribute("data-spawn-cmd") || "";
      render();
    });
  });

  document.querySelectorAll("[data-pick-dir]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.cwd = el.getAttribute("data-pick-dir");
      const cwdInp = document.getElementById("spawn-cwd");
      if (cwdInp) cwdInp.value = state.spawnForm.cwd;
    });
  });

  // Vault item click
  document.querySelectorAll("[data-vault-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      const sid = el.getAttribute("data-vault-idx");
      const found = state.vaultResults.find((x) => x.session_id === sid);
      if (found) openVaultSessionModal(found);
    });
  });

  // Composer textarea Enter key & input sync
  const ta = document.getElementById("composer-textarea");
  if (ta) {
    ta.addEventListener("input", () => {
      state.composerText = ta.value;
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
  if (ta) ta.value = "";
  render();

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

  state.activeModal = null;
  render();

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

render();
connectWebSocket();
