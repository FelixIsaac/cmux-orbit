// cmux-orbit — Agent-First Mobile Mission Control Client

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
  showKeyStrip: false,
  activeModal: null, // null | "spawn" | "ws_switcher" | "vault_preview"
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

function hapticTick() {
  try {
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

function renderMarkdown(md) {
  if (!md) return "";
  let text = escapeHtml(md);

  // Extract fenced code blocks first
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre><code class="lang-${lang || "text"}">${code.trimEnd()}</code></pre>`
    );
    return `@@CODEBLOCK_${idx}@@`;
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

  // Bullet lists
  text = text.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
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
  return `<span class="agent-badge ${meta.cls}">${meta.icon} ${meta.label}</span>`;
}

function renderMissionControl() {
  const dash = state.dashboard;
  if (!dash) {
    return `
      <header class="top-header">
        <div class="header-row">
          <div class="brand-pill"><span class="live-dot"></span> cmux Orbit</div>
        </div>
      </header>
      <main class="mission-body">
        <div class="workspace-card">Connecting to cmux.sock on Mac…</div>
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
    <header class="top-header">
      <div class="header-row">
        <div class="brand-pill">
          <span class="live-dot ${state.connected ? "" : "offline"}"></span>
          <span>cmux Orbit</span>
          <span class="header-stats">${dash.totalWorkspaces} WS · ${dash.totalSurfaces} Surf</span>
        </div>
        <div class="header-actions">
          <button class="icon-btn" data-action="refresh-dash" title="Refresh">↻</button>
          <button class="icon-btn primary" data-action="open-spawn" data-target="workspace">+ Spawn</button>
        </div>
      </div>
      <div class="filter-strip">
        <button class="filter-pill ${state.filter === "all" ? "active" : ""}" data-filter="all">
          All <span class="badge-count">${dash.totalWorkspaces}</span>
        </button>
        <button class="filter-pill ${state.filter === "needs_input" ? "active" : ""}" data-filter="needs_input">
          Needs Input <span class="badge-count amber">${dash.needsInputCount}</span>
        </button>
        <button class="filter-pill ${state.filter === "active" ? "active" : ""}" data-filter="active">
          Running / Unread <span class="badge-count cyan">${dash.runningCount + dash.unreadCount}</span>
        </button>
        <button class="filter-pill ${state.filter === "vault" ? "active" : ""}" data-filter="vault">
          🔍 Vault History
        </button>
      </div>
    </header>

    <main class="mission-body">
      ${
        state.filter === "vault"
          ? renderVaultView()
          : `
        ${
          attentionList.length > 0 && state.filter === "all"
            ? `
          <div class="section-label">
            <span>⚡ Attention & Live Activity (${attentionList.length})</span>
            <span>1-Tap Triage</span>
          </div>
          <div class="attention-stack">
            ${attentionList
              .map(
                (item) => `
              <div class="attention-card ${item.state}" data-open-ws="${item.workspaceId}" data-open-surf="${item.surfaceId}">
                <div class="card-top-row">
                  <div class="ws-tag">
                    <span class="status-ring ${item.state}"></span>
                    <span>${escapeHtml(item.workspaceTitle)}</span>
                  </div>
                  ${renderAgentBadge(item.agentKind)}
                </div>
                <div class="attention-title">${escapeHtml(item.surfaceTitle)}</div>
                <div class="attention-summary">${escapeHtml(item.summary)}</div>
                <div class="inline-action-row">
                  <button class="inline-btn open" data-open-ws="${item.workspaceId}" data-open-surf="${item.surfaceId}">
                    Open Surface →
                  </button>
                  ${
                    item.state === "needs_input"
                      ? `
                    <button class="inline-btn approve" data-quick-key="1" data-ws="${item.workspaceId}" data-surf="${item.surfaceId}">
                      ✓ Yes (1)
                    </button>
                  `
                      : `
                    <button class="inline-btn" data-quick-key="escape" data-ws="${item.workspaceId}" data-surf="${item.surfaceId}">
                      ■ Stop (Esc)
                    </button>
                  `
                  }
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        `
            : ""
        }

        <div class="section-label">
          <span>Workspaces (${workspaces.length})</span>
          <span>Tap any surface pill to jump</span>
        </div>

        <div class="workspace-grid">
          ${workspaces
            .map((ws) => {
              const primarySurf =
                ws.surfaces.find((s) => s.isFocused) || ws.surfaces[0];
              return `
              <div class="workspace-card state-${ws.state}" data-open-ws="${ws.id}" data-open-surf="${primarySurf?.id || ""}">
                <div class="ws-header">
                  <div class="ws-title-group">
                    <div class="ws-title-row">
                      <span class="status-ring ${ws.state}"></span>
                      <span class="ws-title">${escapeHtml(ws.title)}</span>
                      ${ws.isPinned ? `<span class="pin-tag">PINNED</span>` : ""}
                    </div>
                    <div class="ws-cwd">${escapeHtml(shortenPath(ws.cwd))}</div>
                  </div>
                  <span class="badge-count">${ws.surfaces.length} tabs</span>
                </div>
                ${
                  ws.preview
                    ? `<div class="ws-preview">${escapeHtml(ws.preview)}</div>`
                    : ""
                }
                <div class="surface-pills-wrap">
                  ${ws.surfaces
                    .map((s) => {
                      const meta = AGENT_META[s.agentKind] || AGENT_META.shell;
                      return `
                      <div class="surface-chip ${s.isFocused ? "focused" : ""} ${s.state}" data-open-ws="${ws.id}" data-open-surf="${s.id}">
                        <span class="status-ring ${s.state}"></span>
                        <span>${meta.icon}</span>
                        <span class="surface-chip-label">${escapeHtml(s.title)}</span>
                      </div>
                    `;
                    })
                    .join("")}
                </div>
              </div>
            `;
            })
            .join("")}
        </div>
      `
      }
    </main>
  `;
}

function renderVaultView() {
  return `
    <div style="display:flex; gap:8px;">
      <input
        id="vault-search-input"
        class="form-input"
        type="search"
        placeholder="Search Claude, Grok, Codex, Pi, Agy sessions…"
        value="${escapeHtml(state.vaultQuery)}"
      />
      <button class="icon-btn primary" data-action="run-vault-search">Search</button>
    </div>
    <div class="workspace-grid">
      ${state.vaultResults
        .map(
          (s) => `
        <div class="workspace-card" data-vault-idx="${escapeHtml(s.session_id)}">
          <div class="card-top-row">
            ${renderAgentBadge(s.agent)}
            <span class="ws-cwd">${escapeHtml(s.status || "archived")} · ${escapeHtml((s.modified || "").slice(0, 16).replace("T", " "))}</span>
          </div>
          <div class="attention-title">${escapeHtml(s.title || s.session_id)}</div>
          <div class="ws-cwd">${escapeHtml(shortenPath(s.cwd))}</div>
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

  const telemetry = detail?.telemetry;
  const prompt = detail?.detectedPrompt;

  return `
    <div class="surface-screen">
      <header class="surface-topbar">
        <div class="topbar-main">
          <button class="back-btn" data-action="go-home">‹ Deck</button>
          <button class="ws-Orbit-pill" data-action="open-ws-switcher">
            <span class="status-ring ${ws?.state || "idle"}"></span>
            <span class="truncate">${escapeHtml(ws?.title || "Workspace")}</span>
            <span>▾</span>
          </button>
          <div class="mode-segmented">
            <button class="mode-tab ${state.viewMode === "agent" ? "active" : ""}" data-mode="agent">✦ Agent</button>
            <button class="mode-tab ${state.viewMode === "terminal" ? "active" : ""}" id="cli-peek-btn" data-mode="terminal" title="Tap for CLI or Hold to X-Ray Peek">&gt;_ CLI</button>
            <button class="mode-tab ${state.viewMode === "diff" ? "active" : ""}" data-mode="diff">± Diff</button>
            ${
              state.docPreview || surf?.kind === "markdown"
                ? `<button class="mode-tab ${state.viewMode === "markdown" ? "active" : ""}" data-mode="markdown">📄 Doc</button>`
                : ""
            }
          </div>
        </div>

        ${
          ws?.surfaces?.length
            ? `
          <div class="surface-scrubber">
            ${ws.surfaces
              .map((s) => {
                const meta = AGENT_META[s.agentKind] || AGENT_META.shell;
                const isAct = s.id === state.activeSurfaceId;
                return `
                <button class="scrubber-tab ${isAct ? "active" : ""}" data-open-ws="${ws.id}" data-open-surf="${s.id}">
                  <span class="status-ring ${s.state}"></span>
                  <span>${meta.icon}</span>
                  <span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.title)}</span>
                </button>
              `;
              })
              .join("")}
            <button class="scrubber-tab" data-action="open-spawn" data-target="surface">+ Tab</button>
          </div>
        `
            : ""
        }

        ${
          telemetry
            ? `
          <div class="telemetry-bar">
            ${telemetry.model ? `<span class="telemetry-chip accent">✦ ${escapeHtml(telemetry.model)}</span>` : ""}
            ${telemetry.contextPercent ? `<span class="telemetry-chip">ctx ${escapeHtml(telemetry.contextPercent)}</span>` : ""}
            ${telemetry.costSession ? `<span class="telemetry-chip">${escapeHtml(telemetry.costSession)}</span>` : ""}
            ${telemetry.costToday ? `<span class="telemetry-chip">today ${escapeHtml(telemetry.costToday)}</span>` : ""}
            ${telemetry.permissionMode ? `<span class="telemetry-chip">${escapeHtml(telemetry.permissionMode)}</span>` : ""}
            ${(telemetry.subagents || [])
              .map(
                (w) =>
                  `<span class="telemetry-chip wave">◯ ${escapeHtml(w.id)}: ${escapeHtml(w.status)}</span>`
              )
              .join("")}
          </div>
        `
            : ""
        }
      </header>

      <main id="surface-viewport" class="surface-viewport">
        ${renderSurfaceViewportContent(detail, surf, ws)}
      </main>

      ${prompt ? renderTuiPromptDeck(prompt, ws?.id, surf?.id) : ""}

      <footer class="composer-dock" id="composer-dock">
        ${
          state.showKeyStrip || state.viewMode === "terminal"
            ? `
          <div class="key-strip">
            <button class="key-pill" data-send-key="escape">esc</button>
            <button class="key-pill" data-send-key="ctrl+c">^C</button>
            <button class="key-pill" data-send-key="tab">tab</button>
            <button class="key-pill" data-send-key="shift+tab">⇧tab</button>
            <button class="key-pill" data-send-key="up">↑</button>
            <button class="key-pill" data-send-key="down">↓</button>
            <button class="key-pill" data-send-key="left">←</button>
            <button class="key-pill" data-send-key="right">→</button>
            <button class="key-pill" data-send-key="space">␣</button>
            <button class="key-pill" data-send-key="enter">↵</button>
            <button class="key-pill slash" data-insert-slash="/status">/status</button>
            <button class="key-pill slash" data-insert-slash="/compact">/compact</button>
            <button class="key-pill slash" data-insert-slash="/resume">/resume</button>
          </div>
        `
            : ""
        }
        <div class="composer-row">
          <button class="prefix-toggle ${state.composerMode === "shell" ? "shell-mode" : ""}" data-action="toggle-composer-mode">
            ${state.composerMode === "shell" ? "$ Cmd" : "✦ Ask"}
          </button>
          <button class="icon-btn" data-action="toggle-keys" title="Toggle Terminal Keys">⌘</button>
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
                : `Message ${AGENT_META[surf?.agentKind]?.label || "surface"} or /command…`
            }"
          >${escapeHtml(state.composerText)}</textarea>
          <button class="send-btn" data-action="submit-composer">↑</button>
        </div>
      </footer>
    </div>
  `;
}

function renderSurfaceViewportContent(detail, surf, ws) {
  if (state.surfaceLoading && !detail) {
    return `<div class="workspace-card">Loading surface stream…</div>`;
  }

  if (state.viewMode === "markdown") {
    const doc = state.docPreview || detail?.markdownDocument;
    if (!doc) {
      return `<div class="workspace-card">No markdown document selected.</div>`;
    }
    return `
      <div class="turn-assistant">
        <div class="turn-header">
          <span>📄 ${escapeHtml(doc.name)}</span>
          <span>${escapeHtml(shortenPath(doc.path))}</span>
        </div>
        <div class="prose">${renderMarkdown(doc.content)}</div>
      </div>
    `;
  }

  if (state.viewMode === "diff") {
    if (state.gitDiffLoading) {
      return `<div class="workspace-card">Inspecting git status & unified diff…</div>`;
    }
    const git = state.gitDiffData;
    if (!git || !git.isGitRepo) {
      return `<div class="workspace-card">Not a Git repository (${escapeHtml(surf?.cwd || ws?.cwd || "")})</div>`;
    }
    return `
      <div class="workspace-card">
        <div class="card-top-row">
          <span style="font-weight:650;">⎇ Branch: ${escapeHtml(git.branch || "HEAD")}</span>
          <span class="diff-stats">
            <span class="diff-add">+${git.totalAdditions}</span>
            <span class="diff-del">-${git.totalDeletions}</span>
          </span>
        </div>
        <div class="ws-cwd">${escapeHtml(shortenPath(git.cwd))} · ${git.files.length} changed files</div>
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
            ${
              f.patch
                ? `<pre class="diff-patch">${formatDiffPatch(f.patch)}</pre>`
                : ""
            }
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
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span class="ws-cwd">${escapeHtml(shortenPath(surf?.cwd || ws?.cwd || ""))}</span>
        <div style="display:flex; gap:6px;">
          <button class="icon-btn" data-action="toggle-wrap">${state.terminalWrap ? "⇄ Reflow" : "→ Scroll"}</button>
          <button class="icon-btn" data-action="font-dec">A-</button>
          <button class="icon-btn" data-action="font-inc">A+</button>
        </div>
      </div>
      <pre class="terminal-box ${state.terminalWrap ? "" : "nowrap"}" style="font-size:${state.terminalFontSize}px;">${escapeHtml(rawText)}</pre>
    `;
  }

  // Default: Agent-First Reflowed Stream View
  const messages = detail?.messages || [];
  const detectedFiles = detail?.detectedFiles || [];
  const liveSnippet = detail?.liveProseSnippet || "";
  const agentMeta = AGENT_META[surf?.agentKind] || AGENT_META.shell;

  return `
    ${
      detectedFiles.length > 0
        ? `
      <div class="surface-scrubber">
        ${detectedFiles
          .map((fp) => {
            const name = fp.split("/").pop();
            return `<button class="scrubber-tab" data-preview-file="${escapeHtml(fp)}" data-cwd="${escapeHtml(surf?.cwd || ws?.cwd || "")}">📄 ${escapeHtml(name)}</button>`;
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
        <div class="turn-header">
          <span>${agentMeta.icon} ${agentMeta.label} Surface</span>
          <span>Live Terminal Stream</span>
        </div>
        <div class="prose">
          <p>Showing live reflowed terminal output for <strong>${escapeHtml(surf?.title || "")}</strong>.</p>
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
            <div class="turn-header">
              <span>${agentMeta.icon} ${escapeHtml(m.model || agentMeta.label)}</span>
              <span>${escapeHtml((m.timestamp || "").slice(11, 19))}</span>
            </div>
            ${
              m.thinking
                ? `
              <details class="thinking-accordion">
                <summary>
                  <span>💭 Reasoning / Thought Process</span>
                  <span>▾</span>
                </summary>
                <div class="tool-list">
                  <div class="tool-item-summary" style="white-space:pre-wrap;">${escapeHtml(m.thinking)}</div>
                </div>
              </details>
            `
                : ""
            }
            ${
              m.toolCalls && m.toolCalls.length > 0
                ? `
              <details class="tool-accordion">
                <summary>
                  <span>⚡ ${m.toolCalls.length} tool ${m.toolCalls.length === 1 ? "call" : "calls"} · ${escapeHtml(
                    Array.from(new Set(m.toolCalls.map((t) => t.name))).slice(0, 3).join(", ")
                  )}</span>
                  <span>▾</span>
                </summary>
                <div class="tool-list">
                  ${m.toolCalls
                    .map(
                      (tc) => `
                    <div class="tool-item">
                      <div class="tool-item-head">⚡ ${escapeHtml(tc.name)}</div>
                      <div class="tool-item-summary">${escapeHtml(tc.summary)}</div>
                      ${
                        tc.output
                          ? `<div class="tool-item-output">${escapeHtml(tc.output)}</div>`
                          : ""
                      }
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </details>
            `
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
      <div class="live-stream-card">
        <div class="live-stream-head">
          <span>● Live Terminal Tail</span>
          <button class="icon-btn" style="min-height:26px;padding:0 8px;font-size:11px;" data-mode="terminal">Full CLI →</button>
        </div>
        <pre class="live-stream-pre">${escapeHtml(liveSnippet)}</pre>
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
    <section class="tui-action-deck">
      <div class="tui-deck-header">
        <span>⚡ ${escapeHtml(prompt.title)}</span>
        <button class="icon-btn" style="min-height:26px;padding:0 8px;font-size:11px;" data-action="toggle-keys">⌘ Keys</button>
      </div>
      ${
        prompt.subtitle
          ? `<div class="ws-cwd">${escapeHtml(prompt.subtitle)}</div>`
          : ""
      }
      <div class="tui-options-grid">
        ${prompt.options
          .map(
            (opt) => `
          <button
            class="tui-option-btn ${opt.style || ""}"
            data-answer-key="${escapeHtml(opt.key)}"
            data-ws="${escapeHtml(workspaceId)}"
            data-surf="${escapeHtml(surfaceId)}"
          >
            ${opt.index && prompt.kind === "numbered" ? `${opt.index}. ` : ""}${escapeHtml(opt.label)}
          </button>
        `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderModal() {
  if (!state.activeModal) return "";

  if (state.activeModal === "ws_switcher") {
    const workspaces = state.dashboard?.workspaces || [];
    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>Switch Workspace</span>
            <button class="icon-btn" data-action="close-modal">✕</button>
          </div>
          <div class="workspace-grid">
            ${workspaces
              .map((w) => {
                const primary = w.surfaces.find((s) => s.isFocused) || w.surfaces[0];
                return `
                <div class="workspace-card" data-open-ws="${w.id}" data-open-surf="${primary?.id || ""}">
                  <div class="card-top-row">
                    <div class="ws-title-row">
                      <span class="status-ring ${w.state}"></span>
                      <span class="ws-title">${escapeHtml(w.title)}</span>
                    </div>
                    <span class="badge-count">${w.surfaces.length} tabs</span>
                  </div>
                  <div class="ws-cwd">${escapeHtml(shortenPath(w.cwd))}</div>
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
      { id: "shell", label: ">_ Plain Shell", cmd: "", desc: "Standard zsh terminal" },
    ];

    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>${sf.target === "workspace" ? "Spawn New Workspace" : "Spawn Surface Tab"}</span>
            <button class="icon-btn" data-action="close-modal">✕</button>
          </div>

          <div class="preset-grid">
            ${presets
              .map(
                (p) => `
              <button class="preset-btn ${sf.preset === p.id ? "selected" : ""}" data-spawn-preset="${p.id}" data-spawn-cmd="${p.cmd}">
                <span style="font-weight:650;font-size:14px;">${p.label}</span>
                <span style="font-size:11px;color:var(--text-muted);">${p.desc}</span>
              </button>
            `
              )
              .join("")}
          </div>

          <div>
            <div class="section-label" style="margin-bottom:6px;">Working Directory</div>
            <input id="spawn-cwd" class="form-input" value="${escapeHtml(sf.cwd)}" placeholder="/Users/felix/Projects/..." />
            <div class="filter-strip" style="margin-top:6px;">
              ${dirs
                .map(
                  (d) =>
                    `<button class="filter-pill" data-pick-dir="${escapeHtml(d.path)}">${escapeHtml(d.label)}</button>`
                )
                .join("")}
            </div>
          </div>

          <div>
            <div class="section-label" style="margin-bottom:6px;">Tab / Workspace Title (Optional)</div>
            <input id="spawn-title" class="form-input" value="${escapeHtml(sf.title)}" placeholder="e.g. Auth Refactor" />
          </div>

          <div>
            <div class="section-label" style="margin-bottom:6px;">Initial Prompt (Optional)</div>
            <input id="spawn-prompt" class="form-input" value="${escapeHtml(sf.initialPrompt)}" placeholder="Kick off first instruction immediately…" />
          </div>

          <button class="send-btn" style="width:100%;height:44px;font-size:15px;" data-action="confirm-spawn">
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
            <button class="icon-btn" data-action="close-modal">✕</button>
          </div>
          <div class="ws-cwd">${escapeHtml(shortenPath(s.cwd))} · ${escapeHtml(s.agent)}</div>
          <div style="display:flex;flex-direction:column;gap:10px;max-height:60dvh;overflow-y:auto;">
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

  // Preserve scroll position of surface-viewport if re-rendering in place
  const prevVp = document.getElementById("surface-viewport");
  const prevScrollTop = prevVp ? prevVp.scrollTop : null;
  const wasNearBottom =
    prevVp && prevVp.scrollHeight - prevVp.scrollTop - prevVp.clientHeight < 80;

  const activeTextarea = document.getElementById("composer-textarea");
  const hadFocus = document.activeElement === activeTextarea;
  if (activeTextarea) {
    state.composerText = activeTextarea.value;
  }

  app.innerHTML =
    (state.screen === "surface" ? renderSurfaceScreen() : renderMissionControl()) +
    renderModal();

  // Restore scroll and focus
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

  // Filter pills
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
      await apiPost({ action: "answer_prompt", workspaceId, surfaceId, key });
    });
  });

  // Key Strip Buttons
  document.querySelectorAll("[data-send-key]").forEach((el) => {
    el.addEventListener("click", async () => {
      const key = el.getAttribute("data-send-key");
      await apiPost({
        action: "send_key",
        workspaceId: state.activeWorkspaceId,
        surfaceId: state.activeSurfaceId,
        key,
      });
    });
  });

  document.querySelectorAll("[data-insert-slash]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      const cmd = el.getAttribute("data-insert-slash");
      const ta = document.getElementById("composer-textarea");
      if (ta) {
        ta.value = cmd + " ";
        state.composerText = ta.value;
        ta.focus();
      }
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
      } else if (act === "toggle-keys") {
        hapticTick();
        state.showKeyStrip = !state.showKeyStrip;
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
      ta.style.height = Math.min(120, ta.scrollHeight) + "px";
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

// Register Service Worker & Start App
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

render();
connectWebSocket();
