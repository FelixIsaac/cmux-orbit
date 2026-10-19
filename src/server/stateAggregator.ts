import { existsSync } from "fs";
import { join } from "path";
import { cmuxRpc, isCmuxConnected, resolveCmuxSocketPath } from "./cmuxSocket";
import {
  analyzeScreenText,
  type AgentStatusTelemetry,
  type DetectedPrompt,
} from "./screenAnalyzer";
import { renderGridToAnsiAndPlain } from "./terminalAnsi";
import {
  getLatestAntigravitySessionId,
  loadHookSessions,
  parseTranscriptFile,
  resolveTranscriptPath,
  type ConversationMessage,
  type HookSessionMetadata,
} from "./transcriptEngine";
import { listRecentDirectories, readFilePreview, redactSecrets } from "./workspaceInspector";

export type AgentBrand =
  | "claude"
  | "grok"
  | "codex"
  | "pi"
  | "antigravity"
  | "markdown"
  | "shell";

export type LifecycleState = "needs_input" | "running" | "unread" | "idle";

export interface OrbitSurfaceSummary {
  id: string;
  workspaceId: string;
  title: string;
  kind: "terminal" | "markdown" | "browser" | string;
  filePath?: string | null;
  cwd?: string;
  isFocused: boolean;
  agentKind: AgentBrand;
  sessionId?: string;
  state: LifecycleState;
  hasHumanObligation: boolean;
  obligationSummary?: string;
  lastPreview?: string;
  lastActivityAt?: string | number;
  transcriptPath?: string | null;
}

export interface OrbitWorkspaceSummary {
  id: string;
  title: string;
  cwd: string;
  isPinned: boolean;
  isSelected: boolean;
  unreadCount: number;
  hasUnread: boolean;
  state: LifecycleState;
  preview?: string;
  lastActivityAt?: number;
  surfaces: OrbitSurfaceSummary[];
}

export interface OrbitDashboardSnapshot {
  timestamp: string;
  stateHash?: string;
  hostName: string;
  cmuxConnected: boolean;
  cmuxSocketPath?: string;
  totalWorkspaces: number;
  totalSurfaces: number;
  needsInputCount: number;
  runningCount: number;
  unreadCount: number;
  needsInputWorkspaceCount?: number;
  activeWorkspaceCount?: number;
  attentionItems: {
    workspaceId: string;
    workspaceTitle: string;
    surfaceId: string;
    surfaceTitle: string;
    agentKind: AgentBrand;
    state: LifecycleState;
    summary: string;
    sessionId?: string;
  }[];
  workspaces: OrbitWorkspaceSummary[];
  recentDirectories: { label: string; path: string }[];
}

export interface OrbitSurfaceDetail {
  workspaceId: string;
  surface: OrbitSurfaceSummary;
  modeDefault: "agent" | "markdown" | "terminal";
  messages: ConversationMessage[];
  rawTerminalText: string;
  rawTerminalAnsi?: string;
  cleanTerminalText: string;
  liveProseSnippet: string | null;
  detectedPrompt: DetectedPrompt | null;
  telemetry: AgentStatusTelemetry | null;
  detectedFiles: string[];
  markdownDocument?: {
    path: string;
    name: string;
    content: string;
    modifiedAt: string;
  } | null;
  isAlternateScreen?: boolean;
  hasMouseTracking?: boolean;
}

export interface VaultSessionEntry {
  agent: string;
  session_id: string;
  title: string;
  cwd: string;
  file: string;
  git_branch?: string;
  created?: string;
  modified?: string;
  status?: string;
  resume_command?: string;
}

let cachedVaultSessions: VaultSessionEntry[] = [];
let lastVaultFetchMs = 0;
let vaultRefreshInFlight: Promise<VaultSessionEntry[]> | null = null;

export async function getVaultSessions(waitIfEmpty = false): Promise<VaultSessionEntry[]> {
  const now = Date.now();
  if (now - lastVaultFetchMs > 60000 && !vaultRefreshInFlight) {
    vaultRefreshInFlight = cmuxRpc<{ sessions: VaultSessionEntry[] }>("vault.sessions", { limit: 120 }, 4500)
      .then((res) => {
        if (res?.sessions) {
          cachedVaultSessions = res.sessions.map((s) => {
            if (s.agent === "antigravity" && s.file?.endsWith("history.jsonl") && s.session_id) {
              const brainLog = join(
                process.env.HOME || "",
                ".gemini/antigravity-cli/brain",
                s.session_id,
                ".system_generated/logs/transcript.jsonl"
              );
              if (existsSync(brainLog)) {
                return { ...s, file: brainLog };
              }
            }
            return s;
          });
          lastVaultFetchMs = Date.now();
        }
        return cachedVaultSessions;
      })
      .catch(() => {
        lastVaultFetchMs = Date.now();
        return cachedVaultSessions;
      })
      .finally(() => {
        vaultRefreshInFlight = null;
      });
  }
  if (waitIfEmpty && cachedVaultSessions.length === 0 && vaultRefreshInFlight) {
    return await vaultRefreshInFlight;
  }
  return cachedVaultSessions;
}

function inferAgentBrand(
  surfaceKind: string,
  title: string,
  explicitKind?: string | null
): AgentBrand {
  if (surfaceKind === "markdown") return "markdown";
  const k = (explicitKind || "").toLowerCase();
  if (k.includes("claude")) return "claude";
  if (k.includes("grok")) return "grok";
  if (k.includes("codex")) return "codex";
  if (k === "pi") return "pi";
  if (k.includes("antigravity") || k === "agy") return "antigravity";

  const t = (title || "").toLowerCase();
  if (t.endsWith("- grok") || t.includes("grok")) return "grok";
  if (t.startsWith("π") || t.startsWith("pi ")) return "pi";
  if (t.includes("claude") || t.startsWith("✳")) return "claude";
  if (t.includes("codex")) return "codex";
  if (t.startsWith("ag ") || t.startsWith("agy ") || t.includes("antigravity")) return "antigravity";
  return "shell";
}

function mapRawState(raw?: string | null): LifecycleState {
  if (!raw) return "idle";
  const s = raw.toLowerCase();
  if (s === "needs_input" || s === "needsinput" || s === "waiting" || s === "blocked") {
    return "needs_input";
  }
  if (s === "running" || s === "working" || s === "active" || s === "streaming") {
    return "running";
  }
  return "idle";
}

let cachedDashboard: { snapshot: OrbitDashboardSnapshot; timestamp: number } | null = null;
let dashboardInFlight: Promise<OrbitDashboardSnapshot> | null = null;

export async function buildDashboardSnapshot(forceRefresh = false): Promise<OrbitDashboardSnapshot> {
  const now = Date.now();
  if (!forceRefresh && cachedDashboard && now - cachedDashboard.timestamp < 1000) {
    return cachedDashboard.snapshot;
  }
  if (!forceRefresh && dashboardInFlight) {
    return await dashboardInFlight;
  }

  dashboardInFlight = (async () => {
    try {
      const snapshot = await _buildDashboardSnapshotInternal();
      cachedDashboard = { snapshot, timestamp: Date.now() };
      return snapshot;
    } finally {
      dashboardInFlight = null;
    }
  })();

  return await dashboardInFlight;
}

async function _buildDashboardSnapshotInternal(): Promise<OrbitDashboardSnapshot> {
  const [mobileWsRes, currentRes, vaultSessions] = await Promise.all([
    cmuxRpc<any>("mobile.workspace.list", {}, 3000).catch(() => null),
    cmuxRpc<any>("current.list", {}, 3000).catch(() => null),
    getVaultSessions(false),
  ]);

  const cmuxOnline = isCmuxConnected();

  // If cmux is unreachable or restarting, preserve existing cached workspaces
  // so the user interface never flashes empty or drops their workspace context.
  if (!mobileWsRes && cachedDashboard?.snapshot?.workspaces?.length) {
    return {
      ...cachedDashboard.snapshot,
      timestamp: new Date().toISOString(),
      cmuxConnected: false,
      cmuxSocketPath: resolveCmuxSocketPath(),
    };
  }

  const { bySurfaceId, bySessionId } = loadHookSessions();
  const vaultFileMap = new Map<string, string>();
  for (const vs of vaultSessions) {
    if (vs.session_id && vs.file) {
      if (vs.file.endsWith("history.jsonl")) {
        const agyBrainLog = join(
          process.env.HOME || "",
          ".gemini/antigravity-cli/brain",
          vs.session_id,
          ".system_generated/logs/transcript.jsonl"
        );
        if (existsSync(agyBrainLog)) {
          vaultFileMap.set(vs.session_id, agyBrainLog);
          continue;
        }
      } else {
        vaultFileMap.set(vs.session_id, vs.file);
      }
    }
  }

  // Index current.list items by panel_id (surface_id)
  const currentBySurface = new Map<string, any>();
  if (currentRes?.items && Array.isArray(currentRes.items)) {
    for (const item of currentRes.items) {
      const projections = item.projections || [];
      for (const proj of projections) {
        if (proj.panel_id) currentBySurface.set(proj.panel_id, item);
        if (proj.stable_surface_id) currentBySurface.set(proj.stable_surface_id, item);
      }
    }
  }

  const rawWorkspaces: any[] = mobileWsRes?.workspaces || [];
  const workspaces: OrbitWorkspaceSummary[] = [];
  const attentionItems: OrbitDashboardSnapshot["attentionItems"] = [];

  for (const rw of rawWorkspaces) {
    const wsId = rw.id;
    const wsTitle = rw.title || "Workspace";
    const wsCwd = rw.current_directory || "";
    const terminalsById = new Map<string, any>();
    for (const term of rw.terminals || []) {
      terminalsById.set(term.id, term);
    }

    const surfaces: OrbitSurfaceSummary[] = [];
    for (const rs of rw.surfaces || []) {
      const surfId = rs.surface_id;
      const termInfo = terminalsById.get(surfId);
      const currItem = currentBySurface.get(surfId);
      const hookMeta: HookSessionMetadata | undefined = bySurfaceId.get(surfId);

      const currAgent = currItem?.agents?.[0];
      const explicitAgentKind =
        currAgent?.kind || hookMeta?.agentKind || termInfo?.agent_source || null;

      const agentKind = inferAgentBrand(rs.kind || "terminal", rs.title || "", explicitAgentKind);
      const surfCwd = currItem?.cwd || termInfo?.current_directory || hookMeta?.cwd || wsCwd;
      let sessionId = currAgent?.session_id || hookMeta?.sessionId;
      if (!sessionId && agentKind === "antigravity") {
        sessionId = getLatestAntigravitySessionId(surfCwd) || undefined;
      }

      // Determine lifecycle state
      const obligations: any[] = currItem?.possible_human_obligations || [];
      const hasHumanObligation = obligations.length > 0;
      const attentionList: any[] = currItem?.attention || [];
      const hasSurfaceUnread = attentionList.some((a) => a.kind === "unread");

      let state: LifecycleState = "idle";
      const currState = mapRawState(currAgent?.state);
      const hookState = mapRawState(hookMeta?.lifecycle);
      const termState = mapRawState(termInfo?.agent_state);

      if (hasHumanObligation || currState === "needs_input" || hookState === "needs_input" || termState === "needs_input") {
        state = "needs_input";
      } else if (currState === "running" || hookState === "running" || termState === "running") {
        state = "running";
      } else if (hasSurfaceUnread) {
        state = "unread";
      }

      const obligationSummary =
        obligations[0]?.summary ||
        obligations[0]?.reason ||
        hookMeta?.lastBody ||
        hookMeta?.lastSubtitle ||
        rw.preview ||
        undefined;

      const lastPreview =
        hookMeta?.lastBody ||
        hookMeta?.lastSubtitle ||
        (rs.is_focused ? rw.preview : undefined) ||
        undefined;

      const transcriptPath = sessionId
        ? resolveTranscriptPath(sessionId, agentKind, vaultFileMap, hookMeta)
        : null;

      const surfSummary: OrbitSurfaceSummary = {
        id: surfId,
        workspaceId: wsId,
        title: rs.title || "Terminal",
        kind: rs.kind || "terminal",
        filePath: rs.file_path || null,
        cwd: currItem?.cwd || termInfo?.current_directory || hookMeta?.cwd || wsCwd,
        isFocused: Boolean(rs.is_focused),
        agentKind,
        sessionId,
        state,
        hasHumanObligation,
        obligationSummary,
        lastPreview,
        lastActivityAt: currAgent?.last_activity_at || hookMeta?.updatedAt || rw.last_activity_at,
        transcriptPath,
      };

      surfaces.push(surfSummary);

      if (state === "needs_input" || state === "running") {
        attentionItems.push({
          workspaceId: wsId,
          workspaceTitle: wsTitle,
          surfaceId: surfId,
          surfaceTitle: surfSummary.title,
          agentKind,
          state,
          summary:
            surfSummary.obligationSummary ||
            surfSummary.lastPreview ||
            (state === "needs_input" ? "Waiting for your input or approval" : "Agent actively working"),
          sessionId,
        });
      }
    }

    // Compute aggregate workspace state
    let wsState: LifecycleState = "idle";
    if (surfaces.some((s) => s.state === "needs_input")) {
      wsState = "needs_input";
    } else if (surfaces.some((s) => s.state === "running")) {
      wsState = "running";
    } else if (rw.has_unread || (rw.unread_count || 0) > 0 || surfaces.some((s) => s.state === "unread")) {
      wsState = "unread";
    }

    workspaces.push({
      id: wsId,
      title: wsTitle,
      cwd: wsCwd,
      isPinned: Boolean(rw.is_pinned),
      isSelected: Boolean(rw.is_selected),
      unreadCount: rw.unread_count || 0,
      hasUnread: Boolean(rw.has_unread),
      state: wsState,
      preview: rw.preview || surfaces.find((s) => s.lastPreview)?.lastPreview || "",
      lastActivityAt: rw.last_activity_at,
      surfaces,
    });
  }

  // Sort attentionItems: needs_input first, then running
  attentionItems.sort((a, b) => {
    if (a.state === "needs_input" && b.state !== "needs_input") return -1;
    if (a.state !== "needs_input" && b.state === "needs_input") return 1;
    return 0;
  });

  const totalSurfaces = workspaces.reduce((acc, w) => acc + w.surfaces.length, 0);
  const needsInputCount = workspaces.reduce(
    (acc, w) => acc + w.surfaces.filter((s) => s.state === "needs_input").length,
    0
  );
  const runningCount = workspaces.reduce(
    (acc, w) => acc + w.surfaces.filter((s) => s.state === "running").length,
    0
  );
  const unreadCount = workspaces.filter((w) => w.hasUnread || w.unreadCount > 0 || w.state === "unread").length;
  const needsInputWorkspaceCount = workspaces.filter((w) => w.state === "needs_input").length;
  const activeWorkspaceCount = workspaces.filter(
    (w) => w.state === "running" || w.state === "unread" || w.hasUnread
  ).length;

  const stateHash = `${workspaces.length}:${totalSurfaces}:${needsInputCount}:${runningCount}:${unreadCount}:${needsInputWorkspaceCount}:${activeWorkspaceCount}:${attentionItems.map((a) => `${a.surfaceId}:${a.state}`).join(",")}`;

  const snapshot: OrbitDashboardSnapshot = {
    timestamp: new Date().toISOString(),
    stateHash,
    hostName: "felixs-helm",
    cmuxConnected: cmuxOnline,
    cmuxSocketPath: resolveCmuxSocketPath(),
    totalWorkspaces: workspaces.length,
    totalSurfaces,
    needsInputCount,
    runningCount,
    unreadCount,
    needsInputWorkspaceCount,
    activeWorkspaceCount,
    attentionItems,
    workspaces,
    recentDirectories: listRecentDirectories(workspaces.map((w) => w.cwd)),
  };

  cachedDashboardSnapshot = snapshot;
  cachedDashboardTimestamp = Date.now();
  return snapshot;
}

let cachedDashboardSnapshot: OrbitDashboardSnapshot | null = null;
let cachedDashboardTimestamp = 0;

/**
 * Loads full detail for a specific surface (structured agent conversation + live screen analysis + markdown file if applicable).
 */
export async function getSurfaceDetail(
  workspaceId: string,
  surfaceId: string
): Promise<OrbitSurfaceDetail> {
  let snapshot = cachedDashboardSnapshot;
  if (!snapshot || Date.now() - cachedDashboardTimestamp > 2500) {
    snapshot = await buildDashboardSnapshot();
  }
  const ws =
    snapshot.workspaces.find((w) => w.id === workspaceId) ||
    snapshot.workspaces.find((w) => w.surfaces.some((s) => s.id === surfaceId));
  const surf = ws?.surfaces.find((s) => s.id === surfaceId);

  if (!ws || !surf) {
    throw new Error(`Surface ${surfaceId} not found`);
  }

  // Case 1: Native Markdown viewer surface (e.g. ACCESS-LAYERS-2026-10-01.md in Dax)
  if (surf.kind === "markdown" && surf.filePath) {
    const preview = readFilePreview(surf.filePath, surf.cwd);
    return {
      workspaceId: ws.id,
      surface: surf,
      modeDefault: "markdown",
      messages: [],
      rawTerminalText: "",
      cleanTerminalText: "",
      liveProseSnippet: null,
      detectedPrompt: null,
      telemetry: null,
      detectedFiles: [surf.filePath],
      markdownDocument: {
        path: preview.path,
        name: preview.name,
        content: preview.content,
        modifiedAt: preview.modifiedAt,
      },
    };
  }

  // Case 2: Terminal / Agent surface
  let rawTerminalText = "";
  let rawTerminalAnsi = "";
  let isAlternateScreen = false;
  let hasMouseTracking = false;

  try {
    const replayRes = await cmuxRpc<{ render_grid?: any }>(
      "terminal.replay",
      { surface_id: surf.id },
      2500
    );
    if (replayRes?.render_grid) {
      isAlternateScreen = replayRes.render_grid.active_screen === "alternate";
      hasMouseTracking =
        Array.isArray(replayRes.render_grid.modes) &&
        replayRes.render_grid.modes.some(
          (m: any) =>
            !m.ansi &&
            (m.code === 1000 || m.code === 1002 || m.code === 1003 || m.code === 1006) &&
            m.on
        );
      const result = renderGridToAnsiAndPlain(replayRes.render_grid, 180);
      rawTerminalAnsi = result.ansi;
      if (result.plainText) {
        rawTerminalText = result.plainText;
      }
    }
  } catch {
    // Ignore and fall back to surface.read_text
  }

  if (!rawTerminalText) {
    try {
      const readRes = await cmuxRpc<{ text: string }>(
        "surface.read_text",
        {
          workspace_id: ws.id,
          surface_id: surf.id,
          lines: 140,
          scrollback: true,
        },
        3000
      );
      rawTerminalText = readRes?.text || "";
    } catch {
      rawTerminalText = "";
    }
  }

  if (!rawTerminalAnsi && rawTerminalText) {
    rawTerminalAnsi = rawTerminalText.replace(/\n/g, "\r\n");
  }

  const analysis = analyzeScreenText(rawTerminalText);

  // If the terminal statusline exposed a live SID (e.g. Claude Code statusline `SID: <uuid>`),
  // prefer or fall back to it for resolving the JSONL transcript!
  const effectiveSessionId = analysis.telemetry?.sessionId || surf.sessionId;
  if (effectiveSessionId && !surf.sessionId) {
    surf.sessionId = effectiveSessionId;
  }

  const vaultSessions = await getVaultSessions(false);
  const vaultFileMap = new Map<string, string>();
  for (const vs of vaultSessions) {
    if (vs.session_id && vs.file) {
      if (vs.file.endsWith("history.jsonl")) {
        const agyBrainLog = join(
          process.env.HOME || "",
          ".gemini/antigravity-cli/brain",
          vs.session_id,
          ".system_generated/logs/transcript.jsonl"
        );
        if (existsSync(agyBrainLog)) {
          vaultFileMap.set(vs.session_id, agyBrainLog);
          continue;
        }
      } else {
        vaultFileMap.set(vs.session_id, vs.file);
      }
    }
  }
  const { bySessionId, bySurfaceId } = loadHookSessions();
  const hookMeta =
    (effectiveSessionId ? bySessionId.get(effectiveSessionId) : undefined) ||
    bySurfaceId.get(surf.id);

  let transcriptPath = surf.transcriptPath;
  if (!transcriptPath && effectiveSessionId) {
    transcriptPath = resolveTranscriptPath(
      effectiveSessionId,
      surf.agentKind,
      vaultFileMap,
      hookMeta
    );
    surf.transcriptPath = transcriptPath;
  }

  // Upgrade prompt state if screenAnalyzer detected a numbered or binary prompt
  if (
    analysis.prompt &&
    (analysis.prompt.kind === "numbered" || analysis.prompt.kind === "binary")
  ) {
    surf.state = "needs_input";
  } else if (analysis.prompt && analysis.prompt.kind === "busy") {
    surf.state = "running";
  }

  const messages = transcriptPath
    ? parseTranscriptFile(transcriptPath, surf.agentKind, 35)
    : [];

  // If no JSONL messages were found but hookMeta has a lastBody summary, synthesize an initial card
  if (messages.length === 0 && hookMeta?.lastBody) {
    messages.push({
      id: `hook-${surf.id}`,
      role: "assistant",
      text: hookMeta.lastBody,
      toolCalls: [],
    });
  }

  const modeDefault: "agent" | "markdown" | "terminal" =
    surf.agentKind !== "shell" || messages.length > 0 ? "agent" : "terminal";

  const sanitizedMessages = messages.map((m) => ({
    ...m,
    text: redactSecrets(m.text),
    thinking: m.thinking ? redactSecrets(m.thinking) : undefined,
    toolCalls: m.toolCalls.map((tc) => ({
      ...tc,
      input: tc.input ? redactSecrets(tc.input) : undefined,
      output: tc.output ? redactSecrets(tc.output) : undefined,
    })),
  }));

  return {
    workspaceId: ws.id,
    surface: surf,
    modeDefault,
    messages: sanitizedMessages,
    rawTerminalText: redactSecrets(rawTerminalText),
    rawTerminalAnsi: redactSecrets(rawTerminalAnsi),
    cleanTerminalText: redactSecrets(analysis.cleanLines.join("\n")),
    liveProseSnippet: analysis.liveProseSnippet ? redactSecrets(analysis.liveProseSnippet) : null,
    detectedPrompt: analysis.prompt,
    telemetry: analysis.telemetry,
    detectedFiles: analysis.detectedFiles,
    markdownDocument: null,
    isAlternateScreen,
    hasMouseTracking,
  };
}
