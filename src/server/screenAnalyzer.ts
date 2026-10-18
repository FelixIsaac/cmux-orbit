export interface PromptOption {
  index: number;
  key: string;
  label: string;
  isSelected?: boolean;
  style?: "primary" | "secondary" | "danger";
}

export interface DetectedPrompt {
  kind: "numbered" | "binary" | "busy" | "feed_permission" | "feed_question";
  title: string;
  subtitle?: string;
  options: PromptOption[];
  rawSnippet?: string;
  feedRequestId?: string;
}

export interface SubagentWaveItem {
  id: string;
  title: string;
  status: string;
}

export interface AgentStatusTelemetry {
  model?: string;
  speed?: string;
  sessionId?: string;
  contextPercent?: string;
  compactions?: string;
  costSession?: string;
  burnRate?: string;
  costToday?: string;
  permissionMode?: string;
  subagents: SubagentWaveItem[];
}

export interface ScreenAnalysisResult {
  prompt: DetectedPrompt | null;
  telemetry: AgentStatusTelemetry | null;
  liveProseSnippet: string | null;
  detectedFiles: string[];
  cleanLines: string[];
}

/**
 * Normalizes non-breaking spaces (\u00a0) and strips ANSI escape sequences if any exist.
 */
export function normalizeTerminalText(raw: string): string {
  return raw
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "") // Strip OSC sequences (hyperlinks, titles, OSC 133)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")           // Strip CSI escape sequences
    .replace(/\x1B[@-Z\\-_]/g, "")                     // Strip 2-byte escape sequences
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n");
}

/**
 * Extracts Claude Code / custom statusline telemetry from the bottom of a terminal screen buffer.
 */
export function extractTelemetry(lines: string[]): AgentStatusTelemetry | null {
  const tail = lines.slice(-25);
  const telemetry: AgentStatusTelemetry = { subagents: [] };
  let foundAny = false;

  for (const rawLine of tail) {
    const line = rawLine.trim();
    if (!line) continue;

    // Match: Opus 5.5 (high) | 3.7k t/s | SID: a7e7b95a-ccdb-442e-997b-7bf2e772dbb4
    const sidMatch = line.match(
      /^([A-Za-z0-9._\-\s()+]+?)\s*\|\s*([0-9.]+k?\s*t\/s)\s*\|\s*SID:\s*([a-f0-9\-]{8,})/i
    );
    if (sidMatch) {
      telemetry.model = sidMatch[1].trim();
      telemetry.speed = sidMatch[2].trim();
      telemetry.sessionId = sidMatch[3].trim();
      foundAny = true;
      continue;
    }

    // Match: ctx: ▓▓▓▓░░░░░░ 37.5% | cmpct: ↻ 10
    const ctxMatch = line.match(/ctx:\s*[^\s]*\s*([0-9.]+%)/i);
    if (ctxMatch) {
      telemetry.contextPercent = ctxMatch[1];
      const cmpctMatch = line.match(/cmpct:\s*↻?\s*([0-9]+)/i);
      if (cmpctMatch) telemetry.compactions = cmpctMatch[1];
      foundAny = true;
      continue;
    }

    // Match: cost: $48.70 │ burn:$0.404/m │ 76 lines/$ │ today: $380.78
    const costMatch = line.match(/cost:\s*(\$[0-9.]+)/i);
    if (costMatch) {
      telemetry.costSession = costMatch[1];
      const burnMatch = line.match(/burn:\s*(\$[0-9.]+\/[a-z]+)/i);
      if (burnMatch) telemetry.burnRate = burnMatch[1];
      const todayMatch = line.match(/today:\s*(\$[0-9.]+)/i);
      if (todayMatch) telemetry.costToday = todayMatch[1];
      foundAny = true;
      continue;
    }

    // Match: ⏵⏵ bypass permissions on (shift+tab to cycle)
    if (line.includes("permissions") && (line.includes("⏵") || line.includes("shift+tab"))) {
      telemetry.permissionMode = line
        .replace(/^[⏵▸›>\s]+/, "")
        .replace(/\(shift\+tab[^)]*\)/i, "")
        .trim();
      foundAny = true;
      continue;
    }

    // Match subagent wave rows: ◯ L137  RAG eval v2.4 + Telegram ids 456   12m 32s · ↓ 175.6k tokens
    const waveMatch = line.match(/^[◯◉●]\s+([A-Za-z0-9_\-]+)\s+(.+?)\s{2,}(idle|[0-9]+m\s*[0-9]*s.*|running.*|done.*)$/i);
    if (waveMatch) {
      telemetry.subagents.push({
        id: waveMatch[1].trim(),
        title: waveMatch[2].trim(),
        status: waveMatch[3].trim(),
      });
      foundAny = true;
    }
  }

  return foundAny ? telemetry : null;
}

/**
 * Deterministically detects interactive TUI prompts in the bottom rows of a terminal buffer:
 * 1. Numbered choice / permission menus (e.g. Claude Code / Codex / Grok `❯ 1. Yes`, `2. Yes, allow...`, `3. No`)
 * 2. Binary confirmation prompts (`(y/n)`, `[Y/n]`, `[y/N]`)
 * 3. Active busy/streaming states (`esc to interrupt`, `ctrl+c to cancel`)
 */
export function detectTuiPrompt(rawText: string): DetectedPrompt | null {
  const normalized = normalizeTerminalText(rawText);
  const allLines = normalized.split("\n");
  // Trim trailing blank lines
  while (allLines.length > 0 && !allLines[allLines.length - 1].trim()) {
    allLines.pop();
  }
  if (allLines.length === 0) return null;

  const tail = allLines.slice(-28);

  // 1. Check for numbered option blocks near the bottom
  // Example:
  //   Do you want to proceed?
  // ❯ 1. Yes
  //   2. Yes, and don't ask again for this command
  //   3. No, and tell Claude what to do differently (esc)
  const numberedOptions: { lineIdx: number; index: number; label: string; isSelected: boolean }[] = [];
  for (let i = 0; i < tail.length; i++) {
    const line = tail[i];
    const m = line.match(/^\s*([❯›>●*])?\s*(?:\[|\()?([0-9]{1,2})(?:\]|\)|\.|\))\s+(.+?)\s*$/);
    if (m) {
      const isSelected = Boolean(m[1]);
      const idx = parseInt(m[2], 10);
      const label = m[3].trim();
      numberedOptions.push({ lineIdx: i, index: idx, label, isSelected });
    }
  }

  // Filter for a contiguous or near-contiguous sequence starting at 1 (1, 2, ...)
  if (numberedOptions.length >= 2) {
    // Find the last group that starts with 1 and increments sequentially
    let group: typeof numberedOptions = [];
    for (let i = 0; i < numberedOptions.length; i++) {
      const opt = numberedOptions[i];
      if (opt.index === 1) {
        group = [opt];
      } else if (
        group.length > 0 &&
        opt.index === group[group.length - 1].index + 1 &&
        opt.lineIdx - group[group.length - 1].lineIdx <= 3
      ) {
        group.push(opt);
      }
    }

    // Verify this group is near the bottom of the screen (or right above the status bar)
    if (group.length >= 2 && tail.length - group[group.length - 1].lineIdx <= 14) {
      // Check if there is an interactive cue or question header above `group[0]`
      const firstLineIdx = group[0].lineIdx;
      const headerCandidates: string[] = [];
      for (let j = Math.max(0, firstLineIdx - 6); j < firstLineIdx; j++) {
        const hl = tail[j].trim();
        if (hl && !hl.match(/^[─━═╭╰┌└│]+$/)) {
          headerCandidates.push(hl.replace(/^[│┃]\s*/, "").replace(/\s*[│┃]$/, ""));
        }
      }

      const footerText = tail.slice(group[group.length - 1].lineIdx + 1).join(" ");
      const hasQuestionOrFooter =
        headerCandidates.some((h) => h.includes("?") || /allow|proceed|select|choose|want|permission|confirm|approve/i.test(h)) ||
        /esc to cancel|enter to select|to navigate|shift\+tab/i.test(footerText) ||
        group.some((g) => g.isSelected);

      if (hasQuestionOrFooter) {
        const questionTitle =
          headerCandidates[headerCandidates.length - 1] || "Interactive Prompt";
        const subtitle =
          headerCandidates.length > 1
            ? headerCandidates.slice(0, -1).join(" · ")
            : undefined;

        return {
          kind: "numbered",
          title: questionTitle,
          subtitle,
          options: group.map((g) => {
            const lower = g.label.toLowerCase();
            let style: "primary" | "secondary" | "danger" = "secondary";
            if (g.index === 1 || lower.startsWith("yes") || lower.startsWith("allow") || lower.startsWith("approve")) {
              style = g.index === 1 ? "primary" : "secondary";
            }
            if (lower.startsWith("no") || lower.startsWith("deny") || lower.startsWith("cancel") || lower.startsWith("reject")) {
              style = "danger";
            }
            return {
              index: g.index,
              key: String(g.index),
              label: g.label,
              isSelected: g.isSelected,
              style,
            };
          }),
        };
      }
    }
  }

  // 1b. Check for Arrow-Key Menus (no numbers, but cursor `❯` / `›` with item peers)
  // Example:
  //   Allow command?
  // ❯ Allow once
  //   Allow always for this session
  //   Deny
  const arrowItems: { lineIdx: number; label: string; isSelected: boolean }[] = [];
  let foundCursor = false;
  for (let i = Math.max(0, tail.length - 14); i < tail.length; i++) {
    const rawLine = tail[i];
    const cursorMatch = rawLine.match(/^\s*([❯›>●*])\s{1,4}(.+?)\s*$/);
    const peerMatch = rawLine.match(/^\s{2,6}([A-Za-z0-9][\w\s.,\-_/()':]+?)\s*$/);
    if (cursorMatch && !/^[─━═╭╰┌└│]+$/.test(cursorMatch[2])) {
      foundCursor = true;
      arrowItems.push({ lineIdx: i, label: cursorMatch[2].trim(), isSelected: true });
    } else if (foundCursor && peerMatch && !/^[─━═╭╰┌└│]+$/.test(peerMatch[1])) {
      // Don't treat instructions like "Use arrow keys" as options
      if (!/arrow keys|to navigate|esc to/i.test(peerMatch[1])) {
        arrowItems.push({ lineIdx: i, label: peerMatch[1].trim(), isSelected: false });
      }
    } else if (arrowItems.length > 0 && !cursorMatch && !peerMatch) {
      if (arrowItems.length >= 2) break;
      arrowItems.length = 0;
      foundCursor = false;
    }
  }

  if (arrowItems.length >= 2 && foundCursor) {
    const firstLineIdx = arrowItems[0].lineIdx;
    const headerCandidates: string[] = [];
    for (let j = Math.max(0, firstLineIdx - 4); j < firstLineIdx; j++) {
      const hl = tail[j].trim();
      if (hl && !hl.match(/^[─━═╭╰┌└│]+$/)) {
        headerCandidates.push(hl.replace(/^[│┃]\s*/, "").replace(/\s*[│┃]$/, ""));
      }
    }
    const questionTitle = headerCandidates[headerCandidates.length - 1] || "Select an option";
    return {
      kind: "numbered",
      title: questionTitle,
      options: arrowItems.map((item, idx) => {
        const lower = item.label.toLowerCase();
        let style: "primary" | "secondary" | "danger" = "secondary";
        if (idx === 0 || lower.startsWith("allow") || lower.startsWith("yes") || lower.startsWith("approve")) {
          style = idx === 0 ? "primary" : "secondary";
        }
        if (lower.startsWith("deny") || lower.startsWith("no") || lower.startsWith("cancel") || lower.startsWith("reject")) {
          style = "danger";
        }
        return {
          index: idx + 1,
          key: String(idx + 1),
          label: item.label,
          isSelected: item.isSelected,
          style,
        };
      }),
    };
  }

  // 2. Check for Binary (y/n), [Y/n], [y/N], (yes/no), [y/n/c] confirmation
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 8); i--) {
    const line = tail[i].trim();
    // Inline prompt: "Do you want to proceed? [y/N]"
    const ynMatch = line.match(/^(.+?)\s*(\(\s*[yYnNcCaA/]+\s*\)|\[\s*[yYnNcCaA/]+\s*\]|\(\s*yes\/no\s*\)|\[\s*yes\/no\s*\])\s*:?\s*$/i);
    if (ynMatch) {
      const spec = ynMatch[2].toLowerCase();
      const hasCancel = spec.includes("c");
      const defaultNo = ynMatch[2].includes("N") && !ynMatch[2].includes("Y");
      return {
        kind: "binary",
        title: ynMatch[1].trim(),
        options: [
          { index: 1, key: "y", label: "Yes (y)", isSelected: !defaultNo, style: "primary" },
          { index: 2, key: "n", label: "No (n)", isSelected: defaultNo, style: "danger" },
          ...(hasCancel ? [{ index: 3, key: "c", label: "Cancel (c)", isSelected: false, style: "secondary" as const }] : []),
        ],
      };
    }

    // Standalone prompt on its own line: "[y/N]" or "(y/n)"
    const standAloneMatch = line.match(/^(\(\s*[yYnNcCaA/]+\s*\)|\[\s*[yYnNcCaA/]+\s*\]|\(\s*yes\/no\s*\)|\[\s*yes\/no\s*\])\s*:?\s*$/i);
    if (standAloneMatch && i > 0) {
      const prevLine = tail[i - 1].trim();
      if (prevLine && !/^[─━═╭╰┌└│]+$/.test(prevLine)) {
        const spec = standAloneMatch[1].toLowerCase();
        const hasCancel = spec.includes("c");
        const defaultNo = standAloneMatch[1].includes("N") && !standAloneMatch[1].includes("Y");
        return {
          kind: "binary",
          title: prevLine,
          options: [
            { index: 1, key: "y", label: "Yes (y)", isSelected: !defaultNo, style: "primary" },
            { index: 2, key: "n", label: "No (n)", isSelected: defaultNo, style: "danger" },
            ...(hasCancel ? [{ index: 3, key: "c", label: "Cancel (c)", isSelected: false, style: "secondary" as const }] : []),
          ],
        };
      }
    }
  }

  // 3. Check for Active Streaming / Busy Spinner state
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 12); i--) {
    const line = tail[i].trim();
    if (
      /esc to interrupt|ctrl\+c to cancel/i.test(line) ||
      /^[✻✶✢✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.+?\([0-9]+s/i.test(line)
    ) {
      return {
        kind: "busy",
        title: line.replace(/\s*\(esc to interrupt\)/i, "").trim() || "Agent is working…",
        options: [
          {
            index: 1,
            key: "escape",
            label: "Stop (Esc)",
            style: "danger",
          },
        ],
      };
    }
  }

  return null;
}

/**
 * Extracts file paths mentioned in the terminal output for quick inspection.
 */
export function extractDetectedFiles(rawText: string): string[] {
  const normalized = normalizeTerminalText(rawText);
  const matches = normalized.match(
    /(?:\/Users\/[^\s"'`:<>|()]+|~\/[^\s"'`:<>|()]+|[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]+\.(?:md|ts|tsx|js|py|swift|json|yaml|yml|sh|sql|html|css))/g
  );
  if (!matches) return [];
  const unique = new Set<string>();
  for (const m of matches) {
    const cleaned = m.replace(/[.,;!?)]+$/, "");
    if (cleaned.length > 3 && !cleaned.includes("...")) {
      unique.add(cleaned);
    }
  }
  return Array.from(unique).slice(-12);
}

/**
 * Full analysis pass on a terminal surface's screen text.
 */
export function analyzeScreenText(rawText: string): ScreenAnalysisResult {
  const normalized = normalizeTerminalText(rawText);
  const allLines = normalized.split("\n");
  while (allLines.length > 0 && !allLines[allLines.length - 1].trim()) {
    allLines.pop();
  }

  const telemetry = extractTelemetry(allLines);
  const prompt = detectTuiPrompt(normalized);
  const detectedFiles = extractDetectedFiles(normalized);

  // Filter out noisy statusbar lines from cleanLines so the Agent view has a clean live tail
  const cleanLines = allLines.filter((ln) => {
    const t = ln.trim();
    if (!t) return true;
    if (/^[─━═]{10,}$/.test(t)) return false;
    if (/\|.*t\/s.*\|\s*SID:/i.test(t)) return false;
    if (/^ctx:\s*.*cmpct:/i.test(t)) return false;
    if (/^cost:\s*\$.*burn:/i.test(t)) return false;
    if (/^cache:\s*.*hit:.*wall:/i.test(t)) return false;
    if (/^[⏵▸]+\s*bypass permissions/i.test(t)) return false;
    return true;
  });

  const nonEmptyClean = cleanLines.filter((l) => l.trim().length > 0);
  const liveProseSnippet =
    nonEmptyClean.length > 0 ? nonEmptyClean.slice(-16).join("\n") : null;

  return {
    prompt,
    telemetry,
    liveProseSnippet,
    detectedFiles,
    cleanLines,
  };
}
