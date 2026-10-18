import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolCallItem {
  id: string;
  name: string;
  summary: string;
  input?: string;
  output?: string;
  status?: "done" | "running" | "error";
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  toolCalls: ToolCallItem[];
  timestamp?: string;
  model?: string;
}

export interface HookSessionMetadata {
  agentKind: "claude" | "grok" | "codex" | "pi" | "antigravity" | "unknown";
  sessionId: string;
  surfaceId?: string;
  workspaceId?: string;
  cwd?: string;
  lifecycle: "running" | "idle" | "needs_input" | "unknown";
  lastBody?: string;
  lastSubtitle?: string;
  transcriptPath?: string;
  updatedAt?: number;
}

const HOME = homedir();
const CMUXTERM_DIR = join(HOME, ".cmuxterm");

function normalizeLifecycle(raw?: string | null): "running" | "idle" | "needs_input" | "unknown" {
  if (!raw) return "unknown";
  const l = raw.toLowerCase();
  if (l === "running" || l === "working" || l === "active") return "running";
  if (l === "needsinput" || l === "needs_input" || l === "waiting" || l === "blocked") return "needs_input";
  if (l === "idle" || l === "completed" || l === "done" || l === "stopped") return "idle";
  return "unknown";
}

/**
 * Loads all hook session registries from ~/.cmuxterm/*-hook-sessions.json
 * and indexes them by surfaceId and sessionId.
 */
export function loadHookSessions(): {
  bySurfaceId: Map<string, HookSessionMetadata>;
  bySessionId: Map<string, HookSessionMetadata>;
} {
  const bySurfaceId = new Map<string, HookSessionMetadata>();
  const bySessionId = new Map<string, HookSessionMetadata>();

  const files: { file: string; kind: HookSessionMetadata["agentKind"] }[] = [
    { file: "claude-hook-sessions.json", kind: "claude" },
    { file: "grok-hook-sessions.json", kind: "grok" },
    { file: "codex-hook-sessions.json", kind: "codex" },
    { file: "pi-hook-sessions.json", kind: "pi" },
  ];

  for (const { file, kind } of files) {
    const fullPath = join(CMUXTERM_DIR, file);
    if (!existsSync(fullPath)) continue;
    try {
      const data = JSON.parse(readFileSync(fullPath, "utf8"));
      const sessions = data?.sessions || {};
      const activeBySurface = data?.activeSessionsBySurface || {};

      for (const [sid, raw] of Object.entries<any>(sessions)) {
        const meta: HookSessionMetadata = {
          agentKind: kind,
          sessionId: raw.sessionId || sid,
          surfaceId: raw.surfaceId,
          workspaceId: raw.workspaceId,
          cwd: raw.cwd || raw.launchCommand?.workingDirectory,
          lifecycle: normalizeLifecycle(raw.agentLifecycle || raw.runtimeStatus),
          lastBody: typeof raw.lastBody === "string" ? raw.lastBody : undefined,
          lastSubtitle: typeof raw.lastSubtitle === "string" ? raw.lastSubtitle : undefined,
          transcriptPath: typeof raw.transcriptPath === "string" ? raw.transcriptPath : undefined,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        };

        bySessionId.set(meta.sessionId, meta);
        if (meta.surfaceId) {
          const prev = bySurfaceId.get(meta.surfaceId);
          if (!prev || (meta.updatedAt || 0) >= (prev.updatedAt || 0)) {
            bySurfaceId.set(meta.surfaceId, meta);
          }
        }
      }

      // Apply explicit activeSessionsBySurface overrides if newer
      for (const [surfId, activeEntry] of Object.entries<any>(activeBySurface)) {
        const targetSid = activeEntry?.sessionId;
        if (targetSid && bySessionId.has(targetSid)) {
          bySurfaceId.set(surfId, bySessionId.get(targetSid)!);
        }
      }
    } catch {
      // ignore read/parse error
    }
  }

  return { bySurfaceId, bySessionId };
}

/**
 * Resolves a sessionId + agentKind to an on-disk .jsonl transcript file path.
 */
const transcriptPathCache = new Map<string, string>();

export function resolveTranscriptPath(
  sessionId: string,
  agentKind?: string,
  vaultFileMap?: Map<string, string>,
  hookMeta?: HookSessionMetadata
): string | null {
  if (!sessionId) return null;
  if (hookMeta?.transcriptPath && existsSync(hookMeta.transcriptPath)) {
    return hookMeta.transcriptPath;
  }
  if (vaultFileMap?.has(sessionId)) {
    const vf = vaultFileMap.get(sessionId)!;
    if (existsSync(vf)) return vf;
  }
  if (transcriptPathCache.has(sessionId)) {
    const cached = transcriptPathCache.get(sessionId)!;
    if (existsSync(cached)) return cached;
  }

  // 1. Check ~/.claude/projects/*/<sessionId>.jsonl
  try {
    const claudeProjects = join(HOME, ".claude/projects");
    if (existsSync(claudeProjects)) {
      for (const dir of readdirSync(claudeProjects)) {
        const candidate = join(claudeProjects, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
          transcriptPathCache.set(sessionId, candidate);
          return candidate;
        }
      }
    }
  } catch {
    // ignore
  }

  // 2. Check ~/.grok/sessions/*/<sessionId>/chat_history.jsonl
  try {
    const grokSessions = join(HOME, ".grok/sessions");
    if (existsSync(grokSessions)) {
      for (const dir of readdirSync(grokSessions)) {
        const candidate = join(grokSessions, dir, sessionId, "chat_history.jsonl");
        if (existsSync(candidate)) {
          transcriptPathCache.set(sessionId, candidate);
          return candidate;
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Check ~/.pi/agent/sessions/*/*<sessionId>.jsonl
  try {
    const piSessions = join(HOME, ".pi/agent/sessions");
    if (existsSync(piSessions)) {
      for (const dir of readdirSync(piSessions)) {
        const subDir = join(piSessions, dir);
        for (const f of readdirSync(subDir)) {
          if (f.includes(sessionId) && f.endsWith(".jsonl")) {
            const candidate = join(subDir, f);
            transcriptPathCache.set(sessionId, candidate);
            return candidate;
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 4. Check ~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl
  try {
    const agyCandidate = join(
      HOME,
      ".gemini/antigravity-cli/brain",
      sessionId,
      ".system_generated/logs/transcript.jsonl"
    );
    if (existsSync(agyCandidate)) {
      transcriptPathCache.set(sessionId, agyCandidate);
      return agyCandidate;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Reads the last `maxBytes` of a file and returns complete JSONL lines.
 */
function readTailLines(filePath: string, maxBytes = 600 * 1024): string[] {
  try {
    const st = statSync(filePath);
    if (st.size <= maxBytes) {
      return readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    }
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    closeSync(fd);
    const text = buf.toString("utf8");
    const firstNl = text.indexOf("\n");
    return (firstNl !== -1 ? text.slice(firstNl + 1) : text).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeToolInput(name: string, input: any): string {
  if (!input) return name;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return input.slice(0, 80);
    }
  }
  if (input.command) return String(input.command).replace(/\s+/g, " ").slice(0, 90);
  if (input.file_path || input.path || input.TargetFile || input.AbsolutePath) {
    const p = String(input.file_path || input.path || input.TargetFile || input.AbsolutePath);
    const parts = p.split("/");
    return parts.slice(-2).join("/");
  }
  if (input.pattern || input.query) return String(input.pattern || input.query).slice(0, 70);
  const firstVal = Object.values(input).find((v) => typeof v === "string");
  if (firstVal) return String(firstVal).slice(0, 70);
  return name;
}

function cleanUserText(raw: string): string {
  let s = raw;
  // Extract <user_query>...</user_query> if present (Grok CLI format)
  const uqMatch = s.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (uqMatch) {
    return uqMatch[1].trim();
  }
  // Extract <USER_REQUEST>...</USER_REQUEST> if present (Antigravity format)
  const urMatch = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (urMatch) {
    return urMatch[1].trim();
  }
  // Strip <system-reminder>, <user_info>, <rules>, <context_files> blocks
  s = s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
    .replace(/<rules>[\s\S]*?<\/rules>/gi, "")
    .replace(/<command-name>(.*?)<\/command-name>/gi, "$1 ")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
    .replace(/<command-args>(.*?)<\/command-args>/gi, "$1")
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/gi, "$1")
    .trim();
  return s;
}

/**
 * Parses a JSONL transcript from Claude Code, Grok CLI, OpenAI Codex, Pi, or Antigravity
 * into normalized mobile conversation messages with grouped tool calls.
 */
export function parseTranscriptFile(
  filePath: string,
  agentHint?: string,
  limitMessages = 60
): ConversationMessage[] {
  if (!filePath || !existsSync(filePath)) return [];
  const lines = readTailLines(filePath);
  const messages: ConversationMessage[] = [];
  const toolCallMap = new Map<string, ToolCallItem>();

  const pushOrMergeAssistant = (
    id: string,
    text: string,
    thinking: string | undefined,
    tools: ToolCallItem[],
    timestamp?: string,
    model?: string
  ) => {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === "assistant") {
      if (text) {
        prev.text = prev.text ? `${prev.text}\n\n${text}` : text;
      }
      if (thinking) {
        prev.thinking = prev.thinking ? `${prev.thinking}\n${thinking}` : thinking;
      }
      if (tools.length > 0) {
        prev.toolCalls.push(...tools);
      }
      if (model && !prev.model) prev.model = model;
      if (timestamp) prev.timestamp = timestamp;
      return;
    }
    messages.push({
      id,
      role: "assistant",
      text: text.trim(),
      thinking: thinking?.trim(),
      toolCalls: [...tools],
      timestamp,
      model,
    });
  };

  for (let idx = 0; idx < lines.length; idx++) {
    let obj: any;
    try {
      obj = JSON.parse(lines[idx]);
    } catch {
      continue;
    }

    const type = obj.type;

    // ---------------------------------------------------------
    // 1. CLAUDE CODE & GROK CLI (`type: "user" | "assistant" | "reasoning" | "tool_result"`)
    // ---------------------------------------------------------
    if (type === "user" && obj.message?.role === "user") {
      // Claude Code user turn
      const content = obj.message.content;
      if (typeof content === "string") {
        const cleaned = cleanUserText(content);
        if (cleaned) {
          messages.push({
            id: obj.uuid || `u-${idx}`,
            role: "user",
            text: cleaned,
            toolCalls: [],
            timestamp: obj.timestamp,
          });
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            const c = cleanUserText(block.text);
            if (c) textParts.push(c);
          } else if (block.type === "tool_result" && block.tool_use_id) {
            const tc = toolCallMap.get(block.tool_use_id);
            if (tc) {
              const outStr =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                  ? block.content.map((x: any) => x.text || "").join("\n")
                  : JSON.stringify(block.content);
              tc.output = outStr.slice(0, 1200);
              tc.status = block.is_error ? "error" : "done";
            }
          }
        }
        if (textParts.length > 0) {
          messages.push({
            id: obj.uuid || `u-${idx}`,
            role: "user",
            text: textParts.join("\n").trim(),
            toolCalls: [],
            timestamp: obj.timestamp,
          });
        }
      }
      continue;
    }

    if (type === "assistant" && obj.message?.role === "assistant") {
      // Claude Code assistant turn
      const content = obj.message.content;
      let text = "";
      let thinking = "";
      const tools: ToolCallItem[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            text += (text ? "\n\n" : "") + block.text;
          } else if (block.type === "thinking" && block.thinking) {
            thinking += (thinking ? "\n" : "") + block.thinking;
          } else if (block.type === "tool_use") {
            const tc: ToolCallItem = {
              id: block.id || `tc-${idx}-${tools.length}`,
              name: block.name || "Tool",
              summary: summarizeToolInput(block.name || "Tool", block.input),
              input: JSON.stringify(block.input, null, 2).slice(0, 800),
              status: "done",
            };
            toolCallMap.set(tc.id, tc);
            tools.push(tc);
          }
        }
      }
      if (text || thinking || tools.length > 0) {
        pushOrMergeAssistant(
          obj.uuid || obj.message.id || `a-${idx}`,
          text,
          thinking || undefined,
          tools,
          obj.timestamp,
          obj.message.model
        );
      }
      continue;
    }

    // Grok CLI format (`type: "user"` with `obj.content` directly, `type: "reasoning"`, `type: "assistant"`, `type: "tool_result"`)
    if (type === "user" && obj.content && !obj.message) {
      if (obj.synthetic_reason) continue;
      const rawText = Array.isArray(obj.content)
        ? obj.content.map((c: any) => c.text || "").join("\n")
        : String(obj.content);
      // Skip pure system/user_info headers unless they contain <user_query>
      if (rawText.includes("<user_info>") && !rawText.includes("<user_query>")) {
        continue;
      }
      const cleaned = cleanUserText(rawText);
      if (cleaned) {
        messages.push({
          id: `grok-u-${idx}`,
          role: "user",
          text: cleaned,
          toolCalls: [],
        });
      }
      continue;
    }

    if (type === "reasoning" && Array.isArray(obj.summary)) {
      const thinkText = obj.summary.map((s: any) => s.text || "").join("\n").trim();
      if (thinkText) {
        pushOrMergeAssistant(obj.id || `grok-r-${idx}`, "", thinkText, []);
      }
      continue;
    }

    if (type === "assistant" && !obj.message && ("content" in obj || "tool_calls" in obj)) {
      const text = typeof obj.content === "string" ? obj.content : "";
      const tools: ToolCallItem[] = [];
      if (Array.isArray(obj.tool_calls)) {
        for (const call of obj.tool_calls) {
          const tc: ToolCallItem = {
            id: call.id || `grok-tc-${idx}`,
            name: call.name || "tool",
            summary: summarizeToolInput(call.name || "tool", call.arguments),
            input: typeof call.arguments === "string" ? call.arguments.slice(0, 800) : JSON.stringify(call.arguments),
            status: "done",
          };
          toolCallMap.set(tc.id, tc);
          tools.push(tc);
        }
      }
      if (text || tools.length > 0) {
        pushOrMergeAssistant(`grok-a-${idx}`, text, undefined, tools);
      }
      continue;
    }

    if (type === "tool_result" && obj.tool_call_id) {
      const tc = toolCallMap.get(obj.tool_call_id);
      if (tc && obj.content) {
        tc.output = String(obj.content).slice(0, 1200);
      }
      continue;
    }

    // ---------------------------------------------------------
    // 2. OPENAI CODEX (`type: "response_item"`, `payload.type`)
    // ---------------------------------------------------------
    if (type === "response_item" && obj.payload) {
      const pl = obj.payload;
      if (pl.type === "message" && pl.role === "user" && Array.isArray(pl.content)) {
        const raw = pl.content.map((c: any) => c.text || "").join("\n");
        const cleaned = cleanUserText(raw);
        if (cleaned && !cleaned.startsWith("<environment_context>") && !cleaned.startsWith("# AGENTS.md")) {
          messages.push({
            id: pl.id || `codex-u-${idx}`,
            role: "user",
            text: cleaned,
            toolCalls: [],
            timestamp: obj.timestamp,
          });
        }
      } else if (pl.type === "message" && pl.role === "assistant" && Array.isArray(pl.content)) {
        const text = pl.content.map((c: any) => c.text || "").join("\n").trim();
        if (text) {
          pushOrMergeAssistant(pl.id || `codex-a-${idx}`, text, undefined, [], obj.timestamp);
        }
      } else if (pl.type === "function_call" || pl.type === "custom_tool_call") {
        const name = pl.name || "shell";
        const args = pl.arguments || pl.input || "";
        const tc: ToolCallItem = {
          id: pl.call_id || pl.id || `codex-tc-${idx}`,
          name,
          summary: summarizeToolInput(name, args),
          input: typeof args === "string" ? args.slice(0, 800) : JSON.stringify(args),
          status: "done",
        };
        toolCallMap.set(tc.id, tc);
        pushOrMergeAssistant(`codex-t-${idx}`, "", undefined, [tc], obj.timestamp);
      } else if (pl.type === "function_call_output" || pl.type === "custom_tool_call_output") {
        const tc = toolCallMap.get(pl.call_id);
        if (tc && pl.output) {
          tc.output = String(pl.output).slice(0, 1200);
        }
      }
      continue;
    }

    // ---------------------------------------------------------
    // 3. PI AGENT (`type: "message"`, `obj.message.role`)
    // ---------------------------------------------------------
    if (type === "message" && obj.message) {
      const m = obj.message;
      if (m.role === "user") {
        const raw = Array.isArray(m.content)
          ? m.content.map((c: any) => c.text || "").join("\n")
          : String(m.content || "");
        const cleaned = cleanUserText(raw);
        if (cleaned) {
          messages.push({
            id: obj.id || `pi-u-${idx}`,
            role: "user",
            text: cleaned,
            toolCalls: [],
            timestamp: obj.timestamp,
          });
        }
      } else if (m.role === "assistant") {
        let text = "";
        let thinking = "";
        const tools: ToolCallItem[] = [];
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === "text" && b.text) text += (text ? "\n\n" : "") + b.text;
            if (b.type === "thinking" && b.thinking) thinking += (thinking ? "\n" : "") + b.thinking;
            if (b.type === "toolCall") {
              const tc: ToolCallItem = {
                id: b.id || `pi-tc-${idx}`,
                name: b.name || "tool",
                summary: summarizeToolInput(b.name || "tool", b.arguments),
                input: JSON.stringify(b.arguments),
                status: "done",
              };
              toolCallMap.set(tc.id, tc);
              tools.push(tc);
            }
          }
        }
        if (text || thinking || tools.length > 0) {
          pushOrMergeAssistant(obj.id || `pi-a-${idx}`, text, thinking || undefined, tools, obj.timestamp, m.model);
        }
      }
      continue;
    }

    // ---------------------------------------------------------
    // 4. ANTIGRAVITY (`type: "USER_INPUT" | "PLANNER_RESPONSE"`)
    // ---------------------------------------------------------
    if (type === "USER_INPUT" && obj.content) {
      const cleaned = cleanUserText(String(obj.content));
      if (cleaned && !cleaned.includes("<CONTEXT_SUMMARY>") && !cleaned.includes("<SYSTEM_MESSAGE>")) {
        messages.push({
          id: `agy-u-${obj.step_index ?? idx}`,
          role: "user",
          text: cleaned,
          toolCalls: [],
          timestamp: obj.created_at,
        });
      }
      continue;
    }

    if (type === "PLANNER_RESPONSE") {
      const text = typeof obj.content === "string" ? obj.content : "";
      const thinking = typeof obj.thinking === "string" ? obj.thinking : undefined;
      const tools: ToolCallItem[] = [];
      if (Array.isArray(obj.tool_calls)) {
        for (const tcRaw of obj.tool_calls) {
          tools.push({
            id: tcRaw.id || `agy-tc-${idx}-${tools.length}`,
            name: tcRaw.name || "tool",
            summary: tcRaw.arguments?.toolSummary || summarizeToolInput(tcRaw.name || "tool", tcRaw.arguments),
            status: "done",
          });
        }
      }
      if (text || thinking || tools.length > 0) {
        pushOrMergeAssistant(`agy-a-${obj.step_index ?? idx}`, text, thinking, tools, obj.created_at);
      }
      continue;
    }
  }

  return messages.slice(-limitMessages);
}
