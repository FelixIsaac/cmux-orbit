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
  dashboardHash: null,
  missionSearch: "",
  showAllIdle: false,
  surfacePickerSearch: "",
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
  scrollBySurfaceMode: {}, // `${surfaceId}:${mode}` -> number scrollTop
  viewModeBySurface: {}, // surfaceId -> string mode
  optimisticTurnsBySurface: {}, // surfaceId -> Array<{ role, text, timestamp, isOptimistic }>
  optimisticThinkingBySurface: {}, // surfaceId -> boolean
  optimisticDismissedPromptKey: null, // key of prompt dismissed optimistically
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
  composerAttachments: [], // Array<{ id, filePath, filename, mimeType, size, previewUrl, isImage, uploading?: boolean }>
  activeLightboxSrc: null,
  activeLightboxCaption: null,
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
let lastScrolledSurfaceId = null;

function ensureActiveTabVisible() {
  const tabsContainer = document.getElementById("surface-tabs-container");
  const activeTab = tabsContainer?.querySelector(".surface-tab.active");
  if (!tabsContainer || !activeTab) return;

  if (state.activeSurfaceId === lastScrolledSurfaceId) return;
  lastScrolledSurfaceId = state.activeSurfaceId;

  const cRect = tabsContainer.getBoundingClientRect();
  const tRect = activeTab.getBoundingClientRect();
  // Only scroll if tab is actually outside or partially hidden
  if (tRect.left < cRect.left || tRect.right > cRect.right) {
    const offset = tRect.left - cRect.left - (cRect.width - tRect.width) / 2;
    tabsContainer.scrollLeft += offset; // Instant, zero smooth animation jitter
  }
}

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
      scrollback: 800,
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

    // --- Optimistic Local Echo State ---
    let optimisticEchoBuffer = "";
    let optimisticAckTimer = null;

    function isLocalEchoSafe() {
      if (!activeTerminalInstance) return false;
      if (activeTerminalInstance.buffer?.active?.type === "alternate") return false;
      if (state.surfaceDetail?.isAlternateScreen) return false;
      const mouseMode = activeTerminalInstance.modes?.mouseTrackingMode;
      if (mouseMode && mouseMode !== "none") return false;
      if (state.surfaceDetail?.hasMouseTracking) return false;
      const recentText = state.surfaceDetail?.rawTerminalText || "";
      const lastLine = recentText.trim().split("\n").pop() || "";
      if (/(?:password|passphrase|token|secret)[:\?]\s*$/i.test(lastLine)) return false;
      return true;
    }

    function handleOptimisticInput(data) {
      if (!activeTerminalInstance || !isLocalEchoSafe()) return;
      if (data === "\r") {
        activeTerminalInstance.write("\r\n");
        optimisticEchoBuffer = "";
        return;
      }
      if (data === "\x7f" || data === "\b") {
        if (optimisticEchoBuffer.length > 0) {
          optimisticEchoBuffer = optimisticEchoBuffer.slice(0, -1);
          activeTerminalInstance.write("\b \b");
        }
        return;
      }
      if (data === "\x03") {
        activeTerminalInstance.write("^C\r\n");
        optimisticEchoBuffer = "";
        return;
      }
      if (/^[^\x00-\x1f\x7f-\x9f]+$/.test(data)) {
        activeTerminalInstance.write(data);
        optimisticEchoBuffer += data;
        clearTimeout(optimisticAckTimer);
        optimisticAckTimer = setTimeout(() => {
          optimisticEchoBuffer = "";
        }, 2000);
      }
    }

    // --- TUI & Inertial Touch Scrolling Engine ---
    let touchStartX = 0;
    let touchStartY = 0;
    let lastTouchY = 0;
    let lastTouchTime = 0;
    let touchVelocity = 0;
    let touchAccumulator = 0;
    let inertiaAnimId = null;
    let scrollIndicatorHideTimer = null;

    let pendingTuiLines = 0;
    let isTuiRpcInFlight = false;
    let tuiDispatchTimer = null;
    let lastTouchCol = 1;
    let lastTouchRow = 1;

    function updateScrollIndicator() {
      let indicator = document.getElementById("xterm-scroll-indicator");
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.id = "xterm-scroll-indicator";
        indicator.className = "xterm-scroll-indicator";
        container.appendChild(indicator);
      }
      const buf = activeTerminalInstance?.buffer?.active;
      if (!buf || buf.type === "alternate" || buf.baseY <= 0) {
        indicator.classList.remove("visible");
        return;
      }
      const containerHeight = container.clientHeight;
      const totalRows = buf.baseY + activeTerminalInstance.rows;
      const thumbHeight = Math.max(24, Math.round((activeTerminalInstance.rows / totalRows) * containerHeight));
      const maxTop = containerHeight - thumbHeight;
      const top = Math.round((buf.viewportY / buf.baseY) * maxTop);
      indicator.style.height = `${thumbHeight}px`;
      indicator.style.transform = `translateY(${top}px)`;
      indicator.classList.add("visible");
      clearTimeout(scrollIndicatorHideTimer);
      scrollIndicatorHideTimer = setTimeout(() => {
        indicator?.classList.remove("visible");
      }, 800);
    }

    function queueTuiScroll(lines, touchX, touchY) {
      if (!activeTerminalInstance || !state.activeSurfaceId || !state.activeWorkspaceId) return;
      const rect = container.getBoundingClientRect();
      const cellWidth = rect.width / (activeTerminalInstance.cols || 80);
      const cellHeight = rect.height / (activeTerminalInstance.rows || 24);
      lastTouchCol = Math.min(activeTerminalInstance.cols, Math.max(1, Math.floor((touchX - rect.left) / cellWidth) + 1));
      lastTouchRow = Math.min(activeTerminalInstance.rows, Math.max(1, Math.floor((touchY - rect.top) / cellHeight) + 1));
      pendingTuiLines += lines;

      if (!tuiDispatchTimer && !isTuiRpcInFlight) {
        tuiDispatchTimer = setTimeout(() => {
          tuiDispatchTimer = null;
          flushTuiScroll();
        }, 35);
      }
    }

    async function flushTuiScroll() {
      if (isTuiRpcInFlight || pendingTuiLines === 0 || !state.activeSurfaceId) return;
      const count = pendingTuiLines;
      pendingTuiLines = 0;
      isTuiRpcInFlight = true;
      const mouseMode = activeTerminalInstance?.modes?.mouseTrackingMode;
      const hasMouse = (mouseMode && mouseMode !== "none") || Boolean(state.surfaceDetail?.hasMouseTracking);

      try {
        let payload = "";
        const clampedCount = Math.min(8, Math.abs(count));
        if (hasMouse) {
          const code = count > 0 ? 65 : 64; // SGR wheel down vs up
          payload = `\x1b[<${code};${lastTouchCol};${lastTouchRow}M`.repeat(clampedCount);
        } else {
          const seq = count > 0 ? "\x1b[B" : "\x1b[A"; // DECSET 1007 arrows
          payload = seq.repeat(clampedCount);
        }
        if (payload) {
          await apiPost({
            action: "send_prompt",
            workspaceId: state.activeWorkspaceId,
            surfaceId: state.activeSurfaceId,
            text: payload,
            submit: false,
          });
        }
      } catch {} finally {
        isTuiRpcInFlight = false;
        if (pendingTuiLines !== 0) flushTuiScroll();
      }
    }

    function startInertialScroll(initialVelocity) {
      if (!activeTerminalInstance) return;
      let vel = Math.max(-2.5, Math.min(2.5, initialVelocity));
      let lastT = performance.now();
      let acc = 0;
      const rowH = 18;
      const friction = 0.92;

      function step(now) {
        const dt = now - lastT;
        lastT = now;
        vel *= Math.pow(friction, dt / 16.67);
        acc += vel * dt;
        const lines = Math.trunc(acc / rowH);
        if (lines !== 0) {
          activeTerminalInstance.scrollLines(lines);
          acc -= lines * rowH;
          updateScrollIndicator();
        }
        if (Math.abs(vel) > 0.02) {
          inertiaAnimId = requestAnimationFrame(step);
        } else {
          inertiaAnimId = null;
        }
      }
      inertiaAnimId = requestAnimationFrame(step);
    }

    container.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        if (inertiaAnimId) {
          cancelAnimationFrame(inertiaAnimId);
          inertiaAnimId = null;
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        lastTouchY = touchStartY;
        lastTouchTime = performance.now();
        touchVelocity = 0;
        touchAccumulator = 0;
      }
    }, { passive: true });

    container.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1 && activeTerminalInstance) {
        const t = e.touches[0];
        const currentY = t.clientY;
        const now = performance.now();
        const dt = now - lastTouchTime;
        const deltaY = lastTouchY - currentY;
        if (dt > 0) {
          const instantVel = deltaY / dt;
          touchVelocity = 0.7 * instantVel + 0.3 * touchVelocity;
        }
        lastTouchY = currentY;
        lastTouchTime = now;
        touchAccumulator += deltaY;
        const rowHeight = 18;
        const linesToScroll = Math.trunc(touchAccumulator / rowHeight);
        if (linesToScroll !== 0) {
          touchAccumulator -= linesToScroll * rowHeight;
          const isAlt = activeTerminalInstance.buffer?.active?.type === "alternate" || Boolean(state.surfaceDetail?.isAlternateScreen);
          const mouseMode = activeTerminalInstance.modes?.mouseTrackingMode;
          const hasMouse = (mouseMode && mouseMode !== "none") || Boolean(state.surfaceDetail?.hasMouseTracking);

          if (isAlt || hasMouse) {
            queueTuiScroll(linesToScroll, t.clientX, t.clientY);
          } else {
            activeTerminalInstance.scrollLines(linesToScroll);
            updateScrollIndicator();
          }
        }
      }
    }, { passive: true });

    container.addEventListener("touchend", () => {
      const isAlt = activeTerminalInstance?.buffer?.active?.type === "alternate" || Boolean(state.surfaceDetail?.isAlternateScreen);
      const mouseMode = activeTerminalInstance?.modes?.mouseTrackingMode;
      const hasMouse = (mouseMode && mouseMode !== "none") || Boolean(state.surfaceDetail?.hasMouseTracking);
      if (!isAlt && !hasMouse && Math.abs(touchVelocity) > 0.15) {
        startInertialScroll(touchVelocity);
      }
    }, { passive: true });

    container.addEventListener("wheel", (e) => {
      if (!activeTerminalInstance) return;
      const isAlt = activeTerminalInstance.buffer?.active?.type === "alternate" || Boolean(state.surfaceDetail?.isAlternateScreen);
      const mouseMode = activeTerminalInstance.modes?.mouseTrackingMode;
      const hasMouse = (mouseMode && mouseMode !== "none") || Boolean(state.surfaceDetail?.hasMouseTracking);

      if (isAlt || hasMouse) {
        e.preventDefault();
        const lines = e.deltaY > 0 ? 1 : -1;
        queueTuiScroll(lines, e.clientX, e.clientY);
      } else {
        updateScrollIndicator();
      }
    }, { passive: false });

    // Tap to focus terminal & show mobile keyboard
    container.addEventListener("click", () => {
      if (activeTerminalInstance) {
        activeTerminalInstance.focus();
        const helper = document.querySelector(".xterm-helper-textarea");
        if (helper) helper.focus();
      }
    });

    // Direct terminal typing from keyboard with instant optimistic local echo
    term.onData(async (data) => {
      if (!state.activeSurfaceId || !state.activeWorkspaceId) return;
      handleOptimisticInput(data);
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

    window.addEventListener("resize", syncTerminalViewportSize);
    window.visualViewport?.addEventListener("resize", syncTerminalViewportSize);
  }

  // Update ANSI data
  if (rawAnsi && rawAnsi !== lastTerminalAnsiRendered) {
    activeTerminalInstance.clear();
    activeTerminalInstance.write(rawAnsi);
    lastTerminalAnsiRendered = rawAnsi;

    // Reconcile optimistic buffer against authoritative snapshot
    if (optimisticEchoBuffer) {
      const cleanText = state.surfaceDetail?.cleanTerminalText || state.surfaceDetail?.rawTerminalText || "";
      if (cleanText.endsWith(optimisticEchoBuffer) || cleanText.includes(optimisticEchoBuffer)) {
        optimisticEchoBuffer = "";
      } else {
        activeTerminalInstance.write(optimisticEchoBuffer);
      }
    }

    activeTerminalInstance.scrollToBottom();
    updateScrollIndicator();
    syncTerminalViewportSize();
  }
}

let resizeDebounceTimer = null;
let lastReportedCols = 0;
let lastReportedRows = 0;

function syncTerminalViewportSize() {
  if (!activeTerminalInstance || !activeTerminalFitAddon || state.viewMode !== "terminal") return;
  try {
    activeTerminalFitAddon.fit();
    const cols = activeTerminalInstance.cols;
    const rows = activeTerminalInstance.rows;
    if (cols > 0 && rows > 0 && (cols !== lastReportedCols || rows !== lastReportedRows)) {
      lastReportedCols = cols;
      lastReportedRows = rows;
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(async () => {
        if (!state.activeSurfaceId || !state.activeWorkspaceId) return;
        await apiPost({
          action: "resize_terminal",
          workspaceId: state.activeWorkspaceId,
          surfaceId: state.activeSurfaceId,
          cols,
          rows,
        });
      }, 150);
    }
  } catch {}
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

let markedConfigured = false;
function ensureMarkedConfigured() {
  if (markedConfigured || typeof marked === "undefined") return;
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      code(token) {
        const cleanCode = (token.text || "").replace(/\n$/, "");
        const lang = (token.lang || "text").trim().split(/\s+/)[0];
        const highlighted = highlightCode(cleanCode, lang);
        return `<div class="code-block-wrapper"><div class="code-header"><span>${escapeHtml(lang || "text")}</span><button class="copy-code-btn" onclick="copyCodeSnippet(this)">Copy</button></div><pre><code class="lang-${escapeHtml(lang || "text")}">${highlighted}</code></pre></div>\n`;
      },
      table(token) {
        return `<div class="table-container">${marked.Renderer.prototype.table.call(this, token)}</div>\n`;
      },
      blockquote(token) {
        // Detect GitHub-style Callout Alerts: > [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]
        const match = token.text.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([^\n]*)?(?:\n([\s\S]*))?$/i);
        if (match) {
          const type = match[1].toLowerCase();
          const title = match[2] ? match[2].trim() : "";
          const bodyMarkdown = match[3] ? match[3].trim() : "";
          const bodyHtml = bodyMarkdown ? marked.parse(bodyMarkdown) : "";
          const icons = {
            note: "ℹ️ Note",
            tip: "💡 Tip",
            important: "⚡ Important",
            warning: "⚠️ Warning",
            caution: "🛑 Caution",
          };
          return `<div class="callout-alert ${type}"><div class="callout-title">${icons[type] || type}${title ? `: ${escapeHtml(title)}` : ""}</div>${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ""}</div>\n`;
        }
        return `<blockquote>\n${marked.parse(token.text)}</blockquote>\n`;
      },
      link({ href, title, text }) {
        const cleanHref = (href || "").trim();
        // Prevent javascript: pseudo-protocol XSS
        if (/^\s*javascript:/i.test(cleanHref)) {
          return `<span>${text}</span>`;
        }
        const cleanTitle = title ? ` title="${escapeHtml(title)}"` : "";
        const isExternal = cleanHref.startsWith("http://") || cleanHref.startsWith("https://");
        const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${escapeHtml(cleanHref)}"${cleanTitle}${targetAttr}>${text}</a>`;
      },
      html(token) {
        // Sanitize raw inline HTML tags to prevent XSS from LLM outputs
        return (token.text || token.raw || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      },
      checkbox({ checked }) {
        return `<span class="task-check ${checked ? "" : "unchecked"}">${checked ? "✓" : ""}</span> `;
      },
      image({ href, title, text }) {
        const cleanHref = (href || "").trim();
        let imgSrc = cleanHref;
        if (cleanHref.startsWith("file://")) {
          imgSrc = `/api/media?path=${encodeURIComponent(cleanHref.replace(/^file:\/\//, ""))}`;
        } else if (cleanHref.startsWith("/") || cleanHref.startsWith("~/")) {
          imgSrc = `/api/media?path=${encodeURIComponent(cleanHref)}`;
        }
        const cleanTitle = title ? ` title="${escapeHtml(title)}"` : "";
        const altText = escapeHtml(text || "Image");
        return `<div class="stream-image-wrapper" data-action="open-lightbox" data-src="${escapeHtml(imgSrc)}" data-caption="${altText}"><img src="${escapeHtml(imgSrc)}" alt="${altText}"${cleanTitle} loading="lazy" class="stream-inline-img" /><span class="stream-image-tap-hint">Tap to zoom</span></div>`;
      }
    }
  });
  markedConfigured = true;
}

function renderMarkdown(md) {
  if (!md) return "";
  // Auto-convert bare image paths on their own line into markdown images ![filename](path)
  const preprocessed = md.replace(/^((?:\/[\w\-./]+|\~[\w\-./]+|file:\/\/[^\s'"<>]+)\.(?:png|jpg|jpeg|gif|webp|svg|bmp|ico))$/gim, (match) => {
    const filename = match.split("/").pop() || "image";
    return `![${filename}](${match})`;
  });

  if (typeof marked !== "undefined") {
    ensureMarkedConfigured();
    try {
      return marked.parse(preprocessed);
    } catch {
      // Fall back on parse error
    }
  }
  // Graceful fallback if marked is not available
  return `<p>${escapeHtml(preprocessed).replace(/\n/g, "<br/>")}</p>`;
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
      if (msg.type === "cmux_status") {
        const wasCmuxConnected = state.cmuxConnected;
        state.cmuxConnected = Boolean(msg.connected);
        updateCmuxStatusIndicator(state.cmuxConnected);
        if (state.cmuxConnected && wasCmuxConnected === false) {
          fetchDashboard();
          if (state.screen === "surface" && state.activeSurfaceId) {
            fetchSurfaceDetail(state.activeWorkspaceId, state.activeSurfaceId);
          }
        }
      } else if (msg.type === "dashboard" && msg.data) {
        if (typeof msg.data.cmuxConnected === "boolean") {
          state.cmuxConnected = msg.data.cmuxConnected;
          updateCmuxStatusIndicator(state.cmuxConnected);
        }
        if (msg.data.stateHash && msg.data.stateHash === state.dashboardHash) {
          return;
        }
        state.dashboardHash = msg.data.stateHash;
        state.dashboard = msg.data;
        saveCachedDashboard(msg.data);

        if (state.screen === "mission") {
          const mSearchInp = document.getElementById("mission-search-input");
          const hadSearchFocus = document.activeElement === mSearchInp;
          const searchVal = mSearchInp ? mSearchInp.value : null;

          const vaultInp = document.getElementById("vault-search-input");
          const hadVaultFocus = document.activeElement === vaultInp;
          const vaultVal = vaultInp ? vaultInp.value : null;

          const container = document.getElementById("screen-container");
          if (container) {
            container.innerHTML = renderMissionControl();
            bindMissionEvents();
          }

          if (hadSearchFocus) {
            const nextInp = document.getElementById("mission-search-input");
            if (nextInp) {
              if (searchVal !== null) nextInp.value = searchVal;
              nextInp.focus();
            }
          } else if (hadVaultFocus) {
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

function updateCmuxStatusIndicator(connected) {
  state.cmuxConnected = connected;
  const banner = document.getElementById("cmux-banner");
  if (banner) {
    banner.classList.toggle("visible", !connected);
  }
}

function showToast(message, durationMs = 3200) {
  let toast = document.getElementById("orbit-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "orbit-toast";
    toast.className = "orbit-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, durationMs);
}

async function apiPost(body) {
  hapticTick();
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orbit-Request": "1",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok && !data.ok) {
      showToast(data.error || "Action failed");
    }
    return data;
  } catch (err) {
    showToast(err?.message || "Network error");
    return { ok: false, error: err?.message };
  }
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

function scrollToViewportBottom(smooth = false) {
  const vp = document.getElementById("surface-viewport");
  if (vp) {
    if (smooth) {
      vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
    } else {
      vp.scrollTop = vp.scrollHeight;
    }
    if (state.activeSurfaceId) {
      state.scrollBySurface[state.activeSurfaceId] = vp.scrollHeight;
    }
  }
  if (activeTerminalInstance && state.viewMode === "terminal") {
    activeTerminalInstance.scrollToBottom();
  }
  const btn = document.getElementById("jump-bottom-btn");
  if (btn) btn.classList.remove("visible");
}
window.scrollToViewportBottom = scrollToViewportBottom;

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
  const allWs = dash.workspaces || [];

  const isInputWs = (w) => w.state === "needs_input";
  const isActiveWs = (w) => w.state === "running" || w.state === "unread" || w.hasUnread;

  const inputWsCount = dash.needsInputWorkspaceCount ?? allWs.filter(isInputWs).length;
  const activeWsCount = dash.activeWorkspaceCount ?? allWs.filter(isActiveWs).length;

  let workspaces = allWs;
  if (state.filter === "needs_input") {
    workspaces = allWs.filter(isInputWs);
  } else if (state.filter === "active") {
    workspaces = allWs.filter(isActiveWs);
  }

  if (state.missionSearch) {
    const q = state.missionSearch.toLowerCase();
    workspaces = workspaces.filter(
      (w) =>
        w.title.toLowerCase().includes(q) ||
        w.cwd.toLowerCase().includes(q) ||
        w.surfaces.some((s) => s.title.toLowerCase().includes(q))
    );
  }

  // Triage separation for high scale (e.g. 50 workspaces) under All filter
  const activeWorkspaces = workspaces.filter(
    (w) => w.state === "running" || w.state === "unread" || w.hasUnread || w.isPinned
  );
  const idleWorkspaces = workspaces.filter(
    (w) => !w.isPinned && w.state !== "running" && w.state !== "unread" && !w.hasUnread && w.state !== "needs_input"
  );

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
          All (${allWs.length})
        </button>
        <button class="segment-item ${state.filter === "needs_input" ? "active" : ""}" data-filter="needs_input">
          Input${inputWsCount > 0 ? ` (${inputWsCount})` : ""}
        </button>
        <button class="segment-item ${state.filter === "active" ? "active" : ""}" data-filter="active">
          Active${activeWsCount > 0 ? ` (${activeWsCount})` : ""}
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
          <div class="mission-search-row">
            <input
              id="mission-search-input"
              class="mission-search-input"
              type="search"
              placeholder="Search workspaces, repos, agents…"
              value="${escapeHtml(state.missionSearch)}"
            />
          </div>

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
              : state.filter === "all" && !state.missionSearch
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

          ${
            activeWorkspaces.length > 0 && state.filter === "all"
              ? `
            <div class="section-header">Active &amp; Pinned (${activeWorkspaces.length})</div>
            ${activeWorkspaces
              .map((ws) => renderWorkspaceCard(ws))
              .join("")}
          `
              : ""
          }

          ${
            state.filter === "all"
              ? `
            ${idleWorkspaces.length > 0 ? `<div class="section-header">Workspaces (${idleWorkspaces.length})</div>` : ""}
            ${
              idleWorkspaces.length > 6 && !state.showAllIdle && !state.missionSearch
                ? `
                ${idleWorkspaces.slice(0, 4).map((ws) => renderWorkspaceCard(ws)).join("")}
                <button class="idle-accordion-btn" data-action="toggle-idle-workspaces">
                  <span>Show ${idleWorkspaces.length - 4} More Idle Workspaces</span>
                  <span>▾</span>
                </button>
              `
                : idleWorkspaces.map((ws) => renderWorkspaceCard(ws)).join("")
            }
            ${
              idleWorkspaces.length > 6 && state.showAllIdle && !state.missionSearch
                ? `
                <button class="idle-accordion-btn" data-action="toggle-idle-workspaces" style="margin-top:6px;">
                  <span>Collapse Idle Workspaces</span>
                  <span>▴</span>
                </button>
              `
                : ""
            }
          `
              : workspaces.length === 0
              ? `
            <div class="empty-feed" style="padding: 48px 20px; text-align: center;">
              <div style="font-size: 28px; margin-bottom: 8px;">✨</div>
              <div style="font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
                ${state.filter === "needs_input" ? "No Actions Required" : state.filter === "active" ? "No Active Workspaces" : "No Workspaces Found"}
              </div>
              <div style="font-size: 13px; color: var(--text-muted);">
                ${state.filter === "needs_input" ? "All agents are either working or idle." : state.filter === "active" ? "No agents are currently running or unread." : "Try adjusting your search query."}
              </div>
            </div>
          `
              : workspaces.map((ws) => renderWorkspaceCard(ws)).join("")
          }
        `
        }
      </main>
    </div>
  `;
}

function renderWorkspaceCard(ws) {
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
            <span class="vault-card-title">${escapeHtml(s.title || s.session_id)}</span>
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

  // Rule of 6: For workspaces with > 6 surfaces, provide compact picker pill
  if (ws.surfaces.length > 6) {
    const activeSurf = ws.surfaces.find((s) => s.id === state.activeSurfaceId) || ws.surfaces[0];
    const meta = AGENT_META[activeSurf.agentKind] || AGENT_META.shell;
    const needsInputCount = ws.surfaces.filter((s) => s.state === "needs_input").length;
    const runningCount = ws.surfaces.filter((s) => s.state === "running").length;

    return `
      <button class="surface-tab active" data-open-ws="${ws.id}" data-open-surf="${activeSurf.id}">
        <span class="status-dot ${activeSurf.state}"></span>
        <span>${meta.icon}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(activeSurf.title)}</span>
      </button>
      <button class="surface-tab" data-action="open-surface-picker" style="font-weight:600;border-color:rgba(56,189,248,0.35);color:var(--accent-blue);">
        ⊞ ${ws.surfaces.length} Tabs ▾${needsInputCount > 0 ? ` <span class="status-dot needs_input" style="width:6px;height:6px;"></span>` : runningCount > 0 ? ` <span class="status-dot running" style="width:6px;height:6px;"></span>` : ""}
      </button>
      <button class="surface-tab" data-action="open-spawn" data-target="surface">+ Tab</button>
    `;
  }

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
        <button id="jump-bottom-btn" class="jump-bottom-btn" data-action="jump-bottom" onclick="scrollToViewportBottom(true)">
          ${isRunning ? `<span class="status-dot running" style="width:6px;height:6px;"></span> ` : ""}↓ Latest
        </button>
      ` : ""}

      <div id="tui-prompt-dock-container">
        ${prompt ? renderTuiPromptDeck(prompt, ws?.id, surf?.id) : ""}
      </div>

      <footer class="terminal-dock" id="terminal-dock" style="${state.viewMode === "terminal" ? "display:flex;" : "display:none;"}">
        <div class="terminal-keys-row">
          <button class="term-key-btn sigint" data-action="term-key" data-key="ctrl+c" title="Interrupt process (SIGINT)">^C</button>
          <button class="term-key-btn" data-action="term-key" data-key="esc" title="Escape">Esc</button>
          <button class="term-key-btn" data-action="term-key" data-key="tab" title="Tab Autocomplete">Tab</button>
          <button class="term-key-btn accent" data-action="term-key" data-key="enter" title="Enter">↵</button>
          <button class="term-key-btn" data-action="term-toggle-kb" title="Toggle Virtual Keyboard">⌨ Keyboard</button>
          <button class="term-key-btn" data-action="term-clear" title="Clear Screen">Clear</button>
          <button class="term-key-btn" data-action="term-copy" title="Copy Output">Copy</button>
          <button class="term-key-btn" data-action="font-dec" title="Smaller font">A-</button>
          <button class="term-key-btn" data-action="font-inc" title="Larger font">A+</button>
        </div>
      </footer>

      <footer class="composer-dock" id="composer-dock" style="${state.viewMode === "terminal" ? "display:none;" : "display:block;"}">
        <div id="composer-attachments-shelf" class="composer-attachments-shelf ${state.composerAttachments.length > 0 ? "visible" : ""}">
          ${state.composerAttachments
            .map(
              (att) => `
            <div class="attachment-pill" data-att-id="${escapeHtml(att.id)}">
              ${
                att.isImage || (att.mimeType && att.mimeType.startsWith("image/"))
                  ? `<img src="${escapeHtml(att.previewUrl)}" class="attachment-thumb" data-action="open-lightbox" data-src="${escapeHtml(att.previewUrl)}" data-caption="${escapeHtml(att.filename)}" alt="thumb" />`
                  : `<span class="attachment-doc-icon">📄</span>`
              }
              <span class="attachment-name" title="${escapeHtml(att.filename)}">${escapeHtml(att.filename)}${att.uploading ? " (uploading…)" : ""}</span>
              <button class="attachment-remove-btn" data-action="remove-attachment" data-id="${escapeHtml(att.id)}" title="Remove">✕</button>
            </div>
          `
            )
            .join("")}
        </div>
        <div class="composer-shell">
          <button class="composer-tool-btn" data-action="pick-attachment" title="Attach image or file">📎</button>
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
        <input type="file" id="composer-file-input" accept="image/*,.pdf,.txt,.md,.json,.csv,.log" multiple style="display:none;" />
      </footer>
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

function extractMediaPaths(text) {
  if (!text) return { cleanText: "", images: [] };
  const images = [];
  const imageRegex = /(?:!\[([^\]]*)\]\(([^)]+)\)|(?:(?:\/[\w\-./]+|\~[\w\-./]+|file:\/\/[^\s'"<>]+)\.(?:png|jpg|jpeg|gif|webp|svg|bmp|ico)))/gi;

  const clean = text.replace(imageRegex, (match, mdAlt, mdUrl) => {
    let p = (mdUrl || match).trim();
    if (p.startsWith("file://")) {
      p = p.replace(/^file:\/\//, "");
    }
    const filename = p.split("/").pop() || "image.png";
    const mediaUrl = `/api/media?path=${encodeURIComponent(p)}`;
    images.push({
      path: p,
      filename: mdAlt || filename,
      previewUrl: mediaUrl,
    });
    return "";
  }).trim();

  return { cleanText: clean, images };
}

function renderUserTurn(m) {
  const { cleanText, images } = extractMediaPaths(m.text);
  const slideClass = m.isOptimistic ? "turn-slide-in" : "";
  return `
    <div class="turn-user ${slideClass}">
      ${cleanText ? `<div>${escapeHtml(cleanText)}</div>` : ""}
      ${
        images.length > 0
          ? `
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:${cleanText ? "8px" : "0"};">
          ${images
            .map(
              (img) => `
            <div class="stream-image-card" data-action="open-lightbox" data-src="${escapeHtml(img.previewUrl)}" data-caption="${escapeHtml(img.filename)}">
              <img src="${escapeHtml(img.previewUrl)}" alt="${escapeHtml(img.filename)}" loading="lazy" />
              <div class="stream-image-info">
                <span class="stream-image-filename">${escapeHtml(img.filename)}</span>
                <span class="stream-image-badge">Image</span>
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
  let messages = [...(detail?.messages || [])];
  const detectedFiles = detail?.detectedFiles || [];
  const liveSnippet = detail?.liveProseSnippet || "";
  const agentMeta = AGENT_META[surf?.agentKind] || AGENT_META.shell;

  // Reconcile optimistic turns
  const surfId = surf?.id || state.activeSurfaceId;
  const pendingOptimistic = state.optimisticTurnsBySurface[surfId] || [];
  if (pendingOptimistic.length > 0) {
    const confirmedIndices = new Set();
    for (let i = 0; i < pendingOptimistic.length; i++) {
      const opt = pendingOptimistic[i];
      const match = messages.some(
        (m) => m.role === "user" && m.text.trim() === opt.text.trim()
      );
      if (match) {
        confirmedIndices.add(i);
      }
    }
    if (confirmedIndices.size > 0) {
      state.optimisticTurnsBySurface[surfId] = pendingOptimistic.filter((_, i) => !confirmedIndices.has(i));
    }
    for (const opt of state.optimisticTurnsBySurface[surfId] || []) {
      messages.push({
        role: "user",
        text: opt.text,
        timestamp: opt.timestamp,
        isOptimistic: true,
      });
    }
  }

  // If latest message is assistant with substantive content or tool calls, clear optimistic thinking
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "assistant" && (lastMsg.text || (lastMsg.toolCalls && lastMsg.toolCalls.length > 0))) {
      state.optimisticThinkingBySurface[surfId] = false;
    }
  }

  const isThinking =
    Boolean(state.optimisticThinkingBySurface[surfId]) ||
    surf?.state === "running" ||
    (messages.length > 0 && messages[messages.length - 1].role === "user");

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
      messages.length === 0 && !isThinking
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
                return renderUserTurn(m);
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
      isThinking
        ? `
      <div class="turn-assistant turn-slide-in optimistic-assistant-pulse">
        <div class="turn-author">
          <span>${agentMeta.icon} ${agentMeta.label}</span>
          <span class="pulse-badge">Processing</span>
        </div>
        <div class="optimistic-thinking-wave">
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
        </div>
      </div>
    `
        : ""
    }

    ${
      messages.length === 0 && liveSnippet && !isThinking
        ? `
      <div class="workspace-card" style="margin-top:8px;">
        <div class="card-top" style="margin-bottom:4px;">
          <span style="font-size:11px;font-weight:600;color:var(--accent-blue);">● LIVE TERMINAL BUFFER</span>
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

  if (state.activeModal === "surface_picker") {
    const ws = state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId);
    const surfaces = ws?.surfaces || [];
    return `
      <div class="sheet-backdrop" data-action="close-modal">
        <div class="sheet-panel" onclick="event.stopPropagation()">
          <div class="sheet-header">
            <span>${escapeHtml(ws?.title || "Workspace")} — Surfaces (${surfaces.length})</span>
            <button class="btn-icon" data-action="close-modal">✕</button>
          </div>
          <div class="tab-picker-sheet">
            ${surfaces
              .map((s) => {
                const isCurrent = s.id === state.activeSurfaceId;
                const meta = AGENT_META[s.agentKind] || AGENT_META.shell;
                return `
                <div class="workspace-card ${isCurrent ? "active" : ""}" data-open-ws="${ws.id}" data-open-surf="${s.id}">
                  <div class="card-top">
                    <div class="ws-title-row">
                      <span class="status-dot ${s.state}"></span>
                      <span class="ws-title" style="${isCurrent ? "color:#FFFFFF;font-weight:700;" : ""}">${meta.icon} ${escapeHtml(s.title)}</span>
                      ${isCurrent ? `<span class="turn-author-badge" style="color:var(--accent-blue);background:rgba(56,189,248,0.12);">ACTIVE</span>` : ""}
                    </div>
                    <span class="tab-badge">${escapeHtml(s.agentKind || "shell")}</span>
                  </div>
                  ${s.cwd ? `<div class="card-cwd">${escapeHtml(shortenPath(s.cwd))}</div>` : ""}
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
    const currentWs = state.dashboard?.workspaces?.find(
      (w) => w.id === state.activeWorkspaceId
    );
    const presets = [
      { id: "claude", label: "✦ Claude Code", cmd: "claude", desc: "Anthropic CLI agent" },
      { id: "grok", label: "𝕏 Grok CLI", cmd: "grok", desc: "xAI deep research & code" },
      { id: "codex", label: "⚡ Codex", cmd: "codex", desc: "OpenAI reasoning agent" },
      { id: "pi", label: "π Pi Agent", cmd: "pi", desc: "Lightweight coding harness" },
      { id: "agy", label: "▲ Antigravity", cmd: "ag", desc: "Deepmind agentic coding" },
      { id: "shell", label: ">_ Shell", cmd: "", desc: "Standard zsh terminal" },
    ];

    const currentDirObj = dirs.find((d) => d.path === sf.cwd);
    const currentDirName = currentDirObj?.name || (sf.cwd ? sf.cwd.split("/").filter(Boolean).pop() : "Projects");
    const currentDirShort = currentDirObj?.shortPath || shortenPath(sf.cwd);

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

            ${sf.target === "surface" && !sf.showCustomDir ? `
              <div class="dir-context-card">
                <div class="dir-context-left">
                  <span class="dir-context-icon">📁</span>
                  <div class="dir-context-text">
                    <span class="dir-context-name">${escapeHtml(currentWs?.title || currentDirName)}</span>
                    <span class="dir-context-path">${escapeHtml(currentDirShort)}</span>
                  </div>
                </div>
                <button type="button" class="btn-pill" data-action="toggle-custom-dir" style="height:26px;font-size:11.5px;padding:0 10px;">
                  Change ▾
                </button>
              </div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${sf.target === "surface" ? `
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:11.5px;color:var(--text-muted);">Pick project or enter custom path:</span>
                    <button type="button" class="btn-pill" data-action="toggle-custom-dir" style="height:22px;font-size:10.5px;padding:0 8px;">
                      Keep Workspace Root
                    </button>
                  </div>
                ` : ""}

                <div class="dir-chip-scroll">
                  ${dirs
                    .slice(0, 10)
                    .map(
                      (d) =>
                        `<button type="button" class="dir-chip ${sf.cwd === d.path ? "active" : ""}" data-pick-dir="${escapeHtml(d.path)}">
                          <span>${d.icon || "📁"}</span>
                          <span class="dir-chip-label">${escapeHtml(d.name || d.label)}</span>
                        </button>`
                    )
                    .join("")}
                </div>

                <div class="dir-input-group">
                  <span class="dir-input-prefix">📁</span>
                  <input id="spawn-cwd" class="form-input dir-input" value="${escapeHtml(sf.cwd)}" placeholder="/Users/felix/Projects/..." />
                  ${sf.cwd ? `<button type="button" class="dir-clear-btn" data-action="clear-spawn-cwd" title="Clear">✕</button>` : ""}
                </div>

                ${dirs.length > 0 ? `
                  <div class="dir-suggestions-list">
                    ${dirs.slice(0, 5).map((d) => `
                      <div class="dir-suggestion-item ${sf.cwd === d.path ? "selected" : ""}" data-pick-dir="${escapeHtml(d.path)}">
                        <span class="dir-sugg-icon">${d.icon || "📁"}</span>
                        <div class="dir-sugg-meta">
                          <span class="dir-sugg-name">${escapeHtml(d.name)}</span>
                          <span class="dir-sugg-path">${escapeHtml(d.shortPath || shortenPath(d.path))}</span>
                        </div>
                        ${sf.cwd === d.path ? `<span class="dir-sugg-check">✓</span>` : ""}
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
              </div>
            `}
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
            <span class="vault-card-title">${escapeHtml(s.title || s.session_id)}</span>
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
                        ? renderUserTurn(m)
                        : `<div class="turn-assistant"><div class="prose">${renderMarkdown(m.text)}</div></div>`
                    )
                    .join("")
            }
          </div>
        </div>
      </div>
    `;
  if (state.activeModal === "lightbox" && state.activeLightboxSrc) {
    const src = state.activeLightboxSrc;
    return `
      <div class="lightbox-backdrop" data-action="close-modal">
        <div class="lightbox-container" onclick="event.stopPropagation()">
          <div class="lightbox-header">
            <span class="lightbox-caption">${escapeHtml(state.activeLightboxCaption || "Image Preview")}</span>
            <div style="display:flex;gap:8px;">
              <a href="${escapeHtml(src)}" target="_blank" download class="btn-icon" title="Open full resolution">↗</a>
              <button class="btn-icon" data-action="close-modal">✕</button>
            </div>
          </div>
          <div class="lightbox-image-wrap">
            <img src="${escapeHtml(src)}" class="lightbox-img" alt="Lightbox Preview" />
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

function openLightboxModal(src, caption = "") {
  hapticTick();
  state.activeLightboxSrc = src;
  state.activeLightboxCaption = caption || "Image Preview";
  openModal("lightbox");
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

    ensureActiveTabVisible();

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
      currentWs?.cwd ||
      state.surfaceDetail?.surface?.cwd ||
      state.dashboard?.recentDirectories?.[0]?.path ||
      "/Users/felix/Projects";
    state.spawnForm.showCustomDir = target === "workspace";
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
          if (b !== el) b.classList.add("tui-btn-dismissed");
        });
        el.classList.add("approved");
        el.innerHTML = `
          <span class="checkmark-circle">
            <svg class="checkmark-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <circle class="checkmark-ring" cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.4)"/>
              <path class="checkmark-stem" d="M8 12.5l2.5 2.5 5.5-5.5"/>
            </svg>
          </span>
          <span>Approved</span>
        `;
        setTimeout(() => {
          banner.classList.add("banner-dismissing");
          setTimeout(() => {
            banner.remove();
            if (state.dashboard?.attentionItems) {
              state.dashboard.attentionItems = state.dashboard.attentionItems.filter(
                (item) => item.surfaceId !== surfaceId
              );
            }
          }, 280);
        }, 320);
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
      } else if (act === "toggle-idle-workspaces") {
        hapticTick();
        state.showAllIdle = !state.showAllIdle;
        const container = document.getElementById("screen-container");
        if (container) {
          container.innerHTML = renderMissionControl();
          bindMissionEvents();
        }
      } else if (act === "run-vault-search") {
        const inp = document.getElementById("vault-search-input");
        state.vaultQuery = inp ? inp.value : "";
        fetchVaultSessions(state.vaultQuery);
      }
    });
  });

  // Mission search input live filtering
  const mSearchInp = document.getElementById("mission-search-input");
  if (mSearchInp) {
    mSearchInp.addEventListener("input", (e) => {
      state.missionSearch = e.target.value;
      const container = document.getElementById("screen-container");
      if (container) {
        container.innerHTML = renderMissionControl();
        bindMissionEvents();
        const nextInp = document.getElementById("mission-search-input");
        if (nextInp) {
          nextInp.focus();
          nextInp.selectionStart = nextInp.selectionEnd = nextInp.value.length;
        }
      }
    });
  }

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
      switchViewMode(m);
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
          switchViewMode("terminal");
        }, 260);
      }
    });
    const endHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (state.peekModePrev) {
        const prev = state.peekModePrev;
        state.peekModePrev = null;
        switchViewMode(prev);
      }
    };
    cliBtn.addEventListener("pointerup", endHold);
    cliBtn.addEventListener("pointercancel", endHold);
  }

  bindTabsEvents();
  bindPromptEvents();
  bindViewportEvents();
  bindTerminalDockEvents();
  bindComposerEvents();
}

function switchViewMode(newMode) {
  const surfId = state.activeSurfaceId;
  const oldMode = state.viewMode;
  if (oldMode === newMode && (newMode !== "terminal" || document.getElementById("xterm-container"))) return;

  const vp = document.getElementById("surface-viewport");
  if (vp && surfId) {
    state.scrollBySurfaceMode[`${surfId}:${oldMode}`] = vp.scrollTop;
  }

  state.viewMode = newMode;
  if (surfId) {
    state.viewModeBySurface[surfId] = newMode;
  }

  // Update mode buttons active class
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    const m = btn.getAttribute("data-mode");
    if (m === "terminal") {
      btn.classList.toggle("active", newMode === "terminal");
    } else {
      btn.classList.toggle("active", newMode === m);
    }
  });

  if (newMode === "diff") {
    const cwd =
      state.surfaceDetail?.surface?.cwd ||
      state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId)?.cwd;
    loadGitDiff(cwd);
  }

  // Update viewport class and content in-place
  if (vp) {
    vp.className =
      newMode === "terminal"
        ? "terminal-view"
        : newMode === "diff"
        ? "diff-view"
        : "conversation-stream";
    const ws = state.dashboard?.workspaces?.find((w) => w.id === state.activeWorkspaceId);
    const surf = state.surfaceDetail?.surface || ws?.surfaces?.find((s) => s.id === surfId);
    vp.innerHTML = renderSurfaceViewportContent(state.surfaceDetail, surf, ws);

    // Restore scroll position for this surface & mode
    const savedScroll = state.scrollBySurfaceMode[`${surfId}:${newMode}`];
    if (savedScroll !== undefined) {
      vp.scrollTop = savedScroll;
    } else if (newMode !== "terminal") {
      vp.scrollTop = vp.scrollHeight;
    }
  }

  // Update footer docks
  const termDock = document.getElementById("terminal-dock");
  const compDock = document.getElementById("composer-dock");
  if (newMode === "terminal") {
    if (compDock) compDock.style.display = "none";
    if (termDock) termDock.style.display = "flex";
    bindTerminalDockEvents();
    const rawAnsi = state.surfaceDetail?.rawTerminalAnsi || state.surfaceDetail?.rawTerminalText || "";
    ensureXtermMounted(rawAnsi);
  } else {
    if (termDock) termDock.style.display = "none";
    if (compDock) compDock.style.display = "block";
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

  tabsContainer.querySelectorAll("[data-action='open-surface-picker']").forEach((el) => {
    el.addEventListener("click", () => {
      openModal("surface_picker");
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

      // Mark prompt optimistically dismissed so background poll doesn't resurrect it
      state.optimisticDismissedPromptKey = `${surfaceId}:${key}`;
      setTimeout(() => {
        if (state.optimisticDismissedPromptKey === `${surfaceId}:${key}`) {
          state.optimisticDismissedPromptKey = null;
        }
      }, 3000);

      const promptDeck = dock.querySelector(".tui-prompt-dock") || dock;
      dock.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
        if (b !== el) {
          b.classList.add("tui-btn-dismissed");
        }
      });

      el.classList.add("approved");
      el.innerHTML = `
        <span class="checkmark-circle">
          <svg class="checkmark-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle class="checkmark-ring" cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.4)"/>
            <path class="checkmark-stem" d="M8 12.5l2.5 2.5 5.5-5.5"/>
          </svg>
        </span>
        <span>Approved</span>
      `;

      setTimeout(() => {
        promptDeck.classList.add("prompt-deck-exit");
        setTimeout(() => {
          dock.innerHTML = "";
          if (state.surfaceDetail?.detectedPrompt) {
            state.surfaceDetail.detectedPrompt = null;
          }
        }, 280);
      }, 320);

      await apiPost({ action: "answer_prompt", workspaceId, surfaceId, key });
    });
  });
}

function bindViewportEvents() {
  const vp = document.getElementById("surface-viewport");
  if (!vp) return;

  const jumpBtn = document.getElementById("jump-bottom-btn");
  if (jumpBtn) {
    jumpBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      hapticTick("light");
      scrollToViewportBottom(true);
    };
  }

  vp.onscroll = () => {
    if (state.activeSurfaceId) {
      state.scrollBySurface[state.activeSurfaceId] = vp.scrollTop;
    }
    const isUp = vp.scrollHeight - vp.scrollTop - vp.clientHeight > 200;
    const btn = document.getElementById("jump-bottom-btn");
    if (btn) btn.classList.toggle("visible", isUp);
  };

  vp.addEventListener("click", (e) => {
    if (e.target === vp || e.target.classList.contains("conversation-stream")) {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")) {
        activeEl.blur();
      }
    }
  });

  vp.ontouchmove = () => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")) {
      activeEl.blur();
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

async function uploadAndAttachFile(file, targetInput = null) {
  if (!file) return;
  hapticTick();
  const tempId = "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const isImg = file.type.startsWith("image/");
  const blobUrl = isImg ? URL.createObjectURL(file) : "";

  const attEntry = {
    id: tempId,
    filePath: "",
    filename: file.name || (isImg ? "pasted-image.png" : "file"),
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    previewUrl: blobUrl,
    isImage: isImg,
    uploading: true,
  };

  if (!targetInput) {
    state.composerAttachments.push(attEntry);
    renderAttachmentsShelf();
  }

  showToast(`Uploading ${attEntry.filename}…`, 1500);

  try {
    const fd = new FormData();
    fd.append("file", file, attEntry.filename);

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "x-orbit-request": "1",
      },
      body: fd,
    });

    const data = await res.json();
    if (data.ok) {
      attEntry.uploading = false;
      attEntry.filePath = data.filePath;
      attEntry.previewUrl = data.previewUrl;
      attEntry.filename = data.filename;
      attEntry.mimeType = data.mimeType;

      if (targetInput) {
        const currentVal = targetInput.value || "";
        targetInput.value = currentVal ? `${currentVal}\n${data.filePath}` : data.filePath;
        targetInput.focus();
        showToast(`Attached ${data.filename}`, 2000);
      } else {
        renderAttachmentsShelf();
        showToast(`Attached ${data.filename}`, 2000);
      }
    } else {
      showToast(`Upload failed: ${data.error || "Server error"}`, 3000);
      removeAttachment(tempId);
    }
  } catch (err) {
    showToast(`Upload error: ${err?.message || "Network error"}`, 3000);
    removeAttachment(tempId);
  }
}

function removeAttachment(id) {
  state.composerAttachments = state.composerAttachments.filter((a) => a.id !== id);
  renderAttachmentsShelf();
}

function renderAttachmentsShelf() {
  const shelf = document.getElementById("composer-attachments-shelf");
  if (!shelf) return;
  if (state.composerAttachments.length === 0) {
    shelf.classList.remove("visible");
    shelf.innerHTML = "";
    return;
  }
  shelf.classList.add("visible");
  shelf.innerHTML = state.composerAttachments
    .map(
      (att) => `
    <div class="attachment-pill" data-att-id="${escapeHtml(att.id)}">
      ${
        att.isImage || (att.mimeType && att.mimeType.startsWith("image/"))
          ? `<img src="${escapeHtml(att.previewUrl)}" class="attachment-thumb" data-action="open-lightbox" data-src="${escapeHtml(att.previewUrl)}" data-caption="${escapeHtml(att.filename)}" alt="thumb" />`
          : `<span class="attachment-doc-icon">📄</span>`
      }
      <span class="attachment-name" title="${escapeHtml(att.filename)}">${escapeHtml(att.filename)}${att.uploading ? " (uploading…)" : ""}</span>
      <button class="attachment-remove-btn" data-action="remove-attachment" data-id="${escapeHtml(att.id)}" title="Remove">✕</button>
    </div>
  `
    )
    .join("");

  shelf.querySelectorAll('[data-action="remove-attachment"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-id");
      removeAttachment(id);
    });
  });
}

function bindComposerEvents() {
  const dock = document.getElementById("composer-dock");
  if (!dock) return;

  const shortcutsBtn = dock.querySelector("[data-action='open-shortcuts']");
  if (shortcutsBtn) shortcutsBtn.addEventListener("click", () => openModal("shortcuts"));

  const pickBtn = dock.querySelector("[data-action='pick-attachment']");
  const fileInput = document.getElementById("composer-file-input");
  if (pickBtn && fileInput) {
    pickBtn.addEventListener("click", () => {
      hapticTick();
      fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      for (const file of files) {
        await uploadAndAttachFile(file);
      }
      fileInput.value = "";
    });
  }

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
    const autoResize = () => {
      ta.style.height = "auto";
      const newHeight = Math.min(180, Math.max(32, ta.scrollHeight));
      ta.style.height = `${newHeight}px`;
    };

    ta.addEventListener("input", () => {
      state.composerText = ta.value;
      if (state.activeSurfaceId) {
        state.draftsBySurface[state.activeSurfaceId] = ta.value;
      }
      autoResize();
    });

    ta.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        await submitComposer();
      }
    });

    // Seamless multimedia paste (Mac Cmd+V, iOS Paste, Android Gboard paste)
    ta.addEventListener("paste", async (e) => {
      const cData = e.clipboardData;
      if (!cData) return;
      const items = Array.from(cData.items || []);
      const mediaItems = items.filter((it) => it.type.startsWith("image/") || it.kind === "file");
      if (mediaItems.length > 0) {
        e.preventDefault();
        for (const item of mediaItems) {
          const file = item.getAsFile();
          if (file) {
            await uploadAndAttachFile(file);
          }
        }
      }
    });
  }

  renderAttachmentsShelf();
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

  dock.querySelectorAll('[data-action="term-toggle-kb"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      hapticTick();
      if (activeTerminalInstance) {
        activeTerminalInstance.focus();
        const xtermTa = document.querySelector(".xterm-helper-textarea");
        if (xtermTa) xtermTa.focus();
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

  root.querySelectorAll("[data-action='toggle-custom-dir']").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.showCustomDir = !state.spawnForm.showCustomDir;
      if (!state.spawnForm.showCustomDir) {
        const currentWs = state.dashboard?.workspaces?.find(
          (w) => w.id === state.activeWorkspaceId
        );
        if (currentWs?.cwd) {
          state.spawnForm.cwd = currentWs.cwd;
        }
      }
      root.innerHTML = renderModal();
      bindModalEvents();
    });
  });

  root.querySelectorAll("[data-pick-dir]").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.cwd = el.getAttribute("data-pick-dir") || "";
      root.innerHTML = renderModal();
      bindModalEvents();
    });
  });

  root.querySelectorAll("[data-action='clear-spawn-cwd']").forEach((el) => {
    el.addEventListener("click", () => {
      hapticTick();
      state.spawnForm.cwd = "";
      root.innerHTML = renderModal();
      bindModalEvents();
      const nextCwdInp = document.getElementById("spawn-cwd");
      if (nextCwdInp) nextCwdInp.focus();
    });
  });

  const cwdInp = root.querySelector("#spawn-cwd");
  if (cwdInp) {
    cwdInp.addEventListener("input", (e) => {
      state.spawnForm.cwd = e.target.value;
    });
  }

  const titleInp = root.querySelector("#spawn-title");
  if (titleInp) {
    titleInp.addEventListener("input", (e) => {
      state.spawnForm.title = e.target.value;
    });
  }

  const promptInp = root.querySelector("#spawn-prompt");
  if (promptInp) {
    promptInp.addEventListener("input", (e) => {
      state.spawnForm.initialPrompt = e.target.value;
    });
    promptInp.addEventListener("paste", async (e) => {
      const cData = e.clipboardData;
      if (!cData) return;
      const items = Array.from(cData.items || []);
      const mediaItems = items.filter((it) => it.type.startsWith("image/") || it.kind === "file");
      if (mediaItems.length > 0) {
        e.preventDefault();
        for (const item of mediaItems) {
          const file = item.getAsFile();
          if (file) {
            await uploadAndAttachFile(file, promptInp);
          }
        }
      }
    });
  }

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
  let raw = (ta ? ta.value : state.composerText).trim();
  const hasAttachments = state.composerAttachments.length > 0;
  if (!raw && !hasAttachments) return;
  if (!state.activeSurfaceId) return;

  const currentAttachments = [...state.composerAttachments];
  state.composerAttachments = [];
  renderAttachmentsShelf();

  // If attachments exist, append file paths to prompt
  let fullPrompt = raw;
  if (currentAttachments.length > 0) {
    const filePaths = currentAttachments.map((a) => a.filePath || a.previewUrl).join("\n");
    fullPrompt = fullPrompt ? `${fullPrompt}\n\n${filePaths}` : filePaths;
  }

  const textToSend =
    state.composerMode === "shell" &&
    state.surfaceDetail?.surface?.agentKind === "claude" &&
    !fullPrompt.startsWith("!")
      ? `! ${fullPrompt}`
      : fullPrompt;

  const surfId = state.activeSurfaceId;
  const wsId = state.activeWorkspaceId;

  state.composerText = "";
  if (surfId) {
    delete state.draftsBySurface[surfId];
  }
  if (ta) {
    ta.value = "";
    ta.style.height = "auto";
  }

  hapticTick("medium");

  // Track optimistic turn in state so background polls preserve it
  if (!state.optimisticTurnsBySurface[surfId]) {
    state.optimisticTurnsBySurface[surfId] = [];
  }
  state.optimisticTurnsBySurface[surfId].push({
    role: "user",
    text: fullPrompt,
    timestamp: new Date().toISOString(),
    isOptimistic: true,
  });
  state.optimisticThinkingBySurface[surfId] = true;

  // Optimistic feedback: append user turn & thinking wave immediately to stream (<16ms)
  const vp = document.getElementById("surface-viewport");
  if (vp && state.viewMode === "agent") {
    const oldPulse = vp.querySelector(".optimistic-assistant-pulse");
    if (oldPulse) oldPulse.remove();

    const dummyUserTurn = {
      role: "user",
      text: fullPrompt,
      isOptimistic: true,
    };
    const userContainer = document.createElement("div");
    userContainer.innerHTML = renderUserTurn(dummyUserTurn);
    const userDiv = userContainer.firstElementChild;
    if (userDiv) vp.appendChild(userDiv);

    const agentMeta = AGENT_META[state.surfaceDetail?.surface?.agentKind] || AGENT_META.shell;
    const pulseDiv = document.createElement("div");
    pulseDiv.className = "turn-assistant turn-slide-in optimistic-assistant-pulse";
    pulseDiv.innerHTML = `
      <div class="turn-author">
        <span>${agentMeta.icon} ${agentMeta.label}</span>
        <span class="pulse-badge">Processing</span>
      </div>
      <div class="optimistic-thinking-wave">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
      </div>
    `;
    vp.appendChild(pulseDiv);
    vp.scrollTop = vp.scrollHeight;
  }

  await apiPost({
    action: "send_prompt",
    workspaceId: wsId,
    surfaceId: surfId,
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
    const keyboardOffset = Math.max(0, window.innerHeight - (vv.height + (vv.offsetTop || 0)));
    const isKeyboardOpen = keyboardOffset > 80;
    document.documentElement.style.setProperty("--keyboard-offset", `${Math.round(keyboardOffset)}px`);
    document.documentElement.style.setProperty("--visual-viewport-height", `${Math.round(vv.height)}px`);
    document.documentElement.style.setProperty(
      "--composer-safe-bottom",
      isKeyboardOpen ? "4px" : "env(safe-area-inset-bottom, 0px)"
    );
    if (activeTerminalFitAddon && state.viewMode === "terminal") {
      try { activeTerminalFitAddon.fit(); } catch {}
    }
  };
  window.visualViewport.addEventListener("resize", onViewportChange);
  window.visualViewport.addEventListener("scroll", onViewportChange);
}

// Register Service Worker & Start App
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Delegated click listener for Jump to Latest and Lightbox
document.addEventListener("click", (e) => {
  const jumpBtn = e.target.closest("#jump-bottom-btn") || e.target.closest("[data-action='jump-bottom']");
  if (jumpBtn) {
    e.preventDefault();
    e.stopPropagation();
    hapticTick("light");
    scrollToViewportBottom(true);
    return;
  }

  const lbTrigger = e.target.closest('[data-action="open-lightbox"]');
  if (lbTrigger) {
    const src = lbTrigger.getAttribute("data-src");
    const caption = lbTrigger.getAttribute("data-caption") || "";
    if (src) {
      e.preventDefault();
      e.stopPropagation();
      openLightboxModal(src, caption);
      return;
    }
  }
});

// Drag and drop multimedia files
window.addEventListener("dragover", (e) => {
  if (state.screen === "surface") {
    e.preventDefault();
    document.getElementById("composer-dock")?.classList.add("drag-over");
  }
});
window.addEventListener("dragleave", () => {
  document.getElementById("composer-dock")?.classList.remove("drag-over");
});
window.addEventListener("drop", async (e) => {
  document.getElementById("composer-dock")?.classList.remove("drag-over");
  if (state.screen === "surface" && e.dataTransfer?.files?.length) {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files)) {
      await uploadAndAttachFile(file);
    }
  }
});

initNavigationState();
render();
connectWebSocket();
