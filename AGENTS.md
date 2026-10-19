# Multi-Agent Architecture, Data State, and Lifecycle Reference

This document serves as the authoritative technical reference for how **cmux-orbit** discovers, parses, aggregates, and renders AI coding agents and interactive CLI sessions running inside **cmux**.

It details:
1. **Multiplexer & Agent Protocols** (cmux IPC, wrappers, and hook shims)
2. **On-Disk Data States** (zero-assumption catalog of session files, transcripts, and registries)
3. **Orbit Parsing & Implication Engine** (how transcripts, statuslines, and terminal grids are parsed)
4. **End-to-End Lifecycle Representation** (how agent turns, tool calls, and human-in-the-loop approvals flow across UI subcomponents)

---

## 1. Multiplexer Architecture & Integration Modes

cmux orchestrates terminal surfaces and multiplexed workspaces. Agents running in cmux interact via one of two distinct architectures:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               cmux Multiplexer                              │
│                                                                             │
│   ┌─────────────────────────────┐         ┌─────────────────────────────┐   │
│   │   Hook-Shimmed Agents       │         │   Native / Standalone CLIs  │   │
│   │   (Claude, Grok, Codex, Pi) │         │   (Antigravity, zsh, bash)  │   │
│   └──────────────┬──────────────┘         └──────────────┬──────────────┘   │
└──────────────────┼───────────────────────────────────────┼──────────────────┘
                   │                                       │
         Writes lifecycle events                 Writes native transcripts
                   │                                       │
                   ▼                                       ▼
    ~/.cmuxterm/*.json                        ~/.gemini/antigravity-cli/brain/
    (claude-hook-sessions.json,               <uuid>/.system_generated/logs/
     grok-hook-sessions.json, etc.)           transcript.jsonl
                   │                                       │
                   └───────────────────┬───────────────────┘
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │       cmux-orbit Server       │
                       │   (stateAggregator.ts &       │
                       │    transcriptEngine.ts)       │
                       └───────────────┬───────────────┘
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │     Mobile Web UI / PWA       │
                       │   (Reflowed Chat Stream +     │
                       │    Touch-Scroll xterm.js)     │
                       └───────────────────────────────┘
```

### A. Hook-Shimmed Agents (`claude`, `grok`, `codex`, `pi`)
cmux injects binary wrapper shims located in `/Applications/cmux.app/Contents/Resources/bin/`:
- `cmux-claude-wrapper`: Wraps `@anthropic-ai/claude-code`, intercepting prompts, tool executions, and diff baselines.
- `cmux-codex-wrapper`: Wraps OpenAI Codex CLI, recording turn ledgers.
- `grok`: Custom wrapper for Grok CLI.
- `cmux-pi-wrapper`: Wrapper for the Pi agent.

These wrappers emit live state directly into `~/.cmuxterm/*.json`. cmux also surfaces this telemetry via the Unix domain socket (`cmux.sock`) methods `current.list`, `mobile.workspace.list`, and `vault.sessions`.

### B. Native / Standalone CLI Agents (`agy` / `ag`, plain shells)
Antigravity CLI (`agy`) runs directly in a cmux PTY without requiring an invasive binary shim. It writes its conversation graph, subagent transcripts, thinking streams, and tool executions to its own application data directory (`~/.gemini/antigravity-cli/`).

`cmux-orbit` bridges this distinction by treating both shimmed and native CLI agents as first-class citizens:
- **For shimmed agents**: Orbit correlates cmux surface IDs with `~/.cmuxterm/*-hook-sessions.json` and agent project directories.
- **For Antigravity**: Orbit resolves working directory paths and session identifiers against `~/.gemini/antigravity-cli/history.jsonl` and canonical brain logs.

---

## 2. On-Disk Data State Catalog (Zero-Assumption Inventory)

Below is the verified schema and filesystem layout for every supported agent environment on disk:

### 1. Google Antigravity (`agy` / `ag`)
- **Root Directory**: `~/.gemini/antigravity-cli/`
- **Command Index / History**: `~/.gemini/antigravity-cli/history.jsonl`
  - *Format*: JSON Lines containing user prompt submissions and metadata:
    ```json
    {"display":"fix the build","timestamp":1792370000000,"workspace":"/Users/felix/Projects","conversationId":"41294be6-8056-4992-aad2-320b241c730c"}
    ```
  - *CRITICAL INVARIANT*: `history.jsonl` is **NOT** a conversation transcript; it does not contain assistant responses, reasoning, or tool outputs. `cmux-orbit` explicitly rejects `history.jsonl` as a transcript candidate.
- **Canonical Transcripts**:
  - Compact: `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
  - Full (untruncated): `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
  - *Line Schemas*:
    - `USER_INPUT`:
      ```json
      {
        "step_index": 1,
        "source": "USER_EXPLICIT",
        "type": "USER_INPUT",
        "created_at": "2026-10-19T08:00:00Z",
        "content": "<CONTEXT_SUMMARY>...</CONTEXT_SUMMARY>\n<USER_REQUEST>Fix the UI</USER_REQUEST>"
      }
      ```
    - `PLANNER_RESPONSE`:
      ```json
      {
        "step_index": 2,
        "source": "MODEL",
        "type": "PLANNER_RESPONSE",
        "created_at": "2026-10-19T08:00:05Z",
        "thinking": "Inspecting transcriptEngine.ts...",
        "content": "I am modifying the path resolution logic.",
        "tool_calls": [
          {
            "id": "call-1",
            "name": "view_file",
            "arguments": {
              "AbsolutePath": "/Users/felix/Projects/cmux-orbit/src/server/transcriptEngine.ts",
              "toolSummary": "View transcriptEngine.ts",
              "toolAction": "Viewing file"
            }
          }
        ]
      }
      ```
    - `GENERIC` (Tool Execution Result):
      ```json
      {
        "step_index": 3,
        "source": "MODEL",
        "type": "GENERIC",
        "status": "DONE",
        "created_at": "2026-10-19T08:00:06Z",
        "content": "File contents:\nexport function resolveTranscriptPath..."
      }
      ```
- **SQLite Stores**: `~/.gemini/antigravity-cli/conversations/<uuid>.db` (local cache) and `conversation_summaries.db`.

### 2. Claude Code (`claude`)
- **Hook Sessions**: `~/.cmuxterm/claude-hook-sessions.json`
  - *Schema*:
    ```json
    {
      "sessions": {
        "f8389e05-12f6-462a-9eb2-7b23673af9db": {
          "sessionId": "f8389e05-12f6-462a-9eb2-7b23673af9db",
          "surfaceId": "E414AFB3-A022-459B-9426-DFAC605D639A",
          "cwd": "/Users/felix/Documents/Obsidian Vault",
          "lifecycle": "needs_input",
          "lastBody": "Waiting for bash approval: git push",
          "updatedAt": 1792370400000
        }
      }
    }
    ```
- **Canonical Transcripts**: `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`
  - *Path Encoding*: `/Users/felix/Projects` → `~/.claude/projects/-Users-felix-Projects/<sessionId>.jsonl`
  - *Line Types*: `type: "user"`, `type: "assistant"`, `type: "tool_use"`, `type: "tool_result"`, `type: "thinking"`.

### 3. Grok CLI (`grok`)
- **Hook Sessions**: `~/.cmuxterm/grok-hook-sessions.json`
- **Canonical Transcripts**: `~/.grok/sessions/<workspace>/<sessionId>/updates.jsonl` and `chat_history.jsonl`
  - *Line Types*: `type: "user"` (with `<user_query>` inside `content`), `type: "reasoning"` (thinking summary), `type: "assistant"`, `type: "tool_result"`.

### 4. OpenAI Codex (`codex`)
- **Hook Sessions**: `~/.cmuxterm/codex-hook-sessions.json`
- **Ledgers**: `~/.cmuxterm/codex-turn-ledger.json`
- **Canonical Transcripts**: `~/.codex/sessions/**/<sessionId>*.jsonl` / `rollout-*.jsonl`
  - *Line Types*: `type: "response_item"` with `payload.type: "message"`, `payload.type: "function_call"`, `payload.type: "function_call_output"`.

### 5. Pi Agent (`pi`)
- **Hook Sessions**: `~/.cmuxterm/pi-hook-sessions.json`
- **Canonical Transcripts**: `~/.pi/agent/sessions/*/*<sessionId>.jsonl`
  - *Line Types*: `type: "message"` with `message.role: "user" | "assistant" | "toolResult"`.

### 6. Interactive Shell (`zsh` / `bash`)
- Virtual terminal PTY with no structured transcript on disk.
- Captured dynamically via cmux RPCs `terminal.replay` and `surface.read_text`.

---

## 3. Orbit Implication and Parsing Engine

`cmux-orbit` implements a multi-tier pipeline to guarantee reliable transcript discovery and display:

### A. Transcript Path Resolution Hierarchy (`resolveTranscriptPath`)
When resolving a transcript for an active surface or vault session:
1. **Agent Hook Metadata**: If `~/.cmuxterm/*-hook-sessions.json` defines a valid `transcriptPath` on disk, it is used immediately.
2. **Antigravity Priority Lookup**: If `agentKind === "antigravity"`, check:
   - `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`
   - `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript_full.jsonl`
3. **Vault File Map Validation**: If `vault.sessions` returned a file for the session:
   - Rejects any file ending with `history.jsonl` (preventing Antigravity command logs from masquerading as transcripts).
   - If valid and existing on disk, returns the path.
4. **Agent Project Scans**:
   - Claude: `~/.claude/projects/*/<sessionId>.jsonl`
   - Grok: `~/.grok/sessions/*/<sessionId>/updates.jsonl`
   - Codex: `~/.codex/sessions/**/<sessionId>*.jsonl`
   - Pi: `~/.pi/agent/sessions/*/*<sessionId>.jsonl`
   - Antigravity Fallback: `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`

### B. User Prompt Cleansing (`cleanUserText`)
Agent CLIs inject extensive system reminders, context summaries, and command artifacts into user turns. Orbit cleanses these to present pure, readable text:
- Extracts `<USER_REQUEST>...</USER_REQUEST>` (Antigravity standard).
- Extracts `<user_query>...</user_query>` (Grok CLI standard).
- Strips `<CONTEXT_SUMMARY>`, `<SYSTEM_MESSAGE>`, `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, `<system-reminder>`, `<user_info>`, `<identity>`, `<guidelines>`, `<skills>`, `<rules>`, and `<conversation_transcript>` blocks.
- Prevents turns from being dropped when sessions undergo context truncation.

### C. Tool Call Aggregation & Output Linking
- **Anthropic / Claude Code**: Correlates `tool_use_id` across `type: "assistant"` and subsequent `type: "user"` with `tool_result` blocks.
- **Antigravity**: Extracts tool declarations and argument schemas from `type: "PLANNER_RESPONSE"` (`tool_calls` array), sets tool inputs, and attaches execution stdout from subsequent `type: "GENERIC"` steps.
- **Codex / Grok / Pi**: Normalizes function calls, custom tool calls, and tool outputs into unified `ToolCallItem` structures (`id`, `name`, `summary`, `input`, `output`, `status`).

### D. Live OCR & Statusline Analysis (`screenAnalyzer.ts`)
For surfaces actively running in a terminal, `screenAnalyzer.ts` parses raw terminal rows:
- **Interactive Prompts**: Detects numbered menus (`[1] Yes  [2] No`), binary questions (`[y/N]`), and arrow-key selectors, elevating surface state to `needs_input`.
- **Busy States**: Detects `esc to interrupt`, spinners, and progress waves, elevating surface state to `running`.
- **Telemetry Extraction**: Scrapes model identifiers (`claude-sonnet-5-5`, `Gemini 2.5`), session UUIDs (`SID: <uuid>`), token counts, and session costs.

### E. ANSI Render Grid Reconstruction (`terminalAnsi.ts`)
When falling back to the raw terminal view, Orbit reconstructs TrueColor ANSI streams from cmux's `render_grid` spans:
- Preserves exact 24-bit RGB foreground and background colors.
- Merges scrollback lines preceding the active viewport.
- Detects alternate screen buffers (`render_grid.active_screen === "alternate"`) and active mouse tracking modes (xterm 1000/1002/1003/1006) for touch gestures.

---

## 4. Representative Lifecycle Management Across Subcomponents

Orbit reflects the complete lifecycle of agents across every interface element:

| Lifecycle State | Trigger / Origin | Mission Control Card | Surface Tab | Conversation View |
|---|---|---|---|---|
| **`needs_input`** | TUI permission prompt (`[1] Yes [2] No`), human obligation in cmux, or hook state `needs_input` | Amber pulsing badge, pinned to triage bucket | Amber dot, active tab focus | Sticky Thumb-Action Sheet (`[1] Yes`, `[2] No`, `[Esc] Cancel`) |
| **`running`** | Streaming delta, active tool execution, or statusline busy indicator | Blue pulsing ring, active turn excerpt | Blue pulsing dot | Animated thinking wave, live tool call disclosure |
| **`unread`** | Agent finished turn with new assistant content while surface unfocused | Cyan unread ring | Cyan badge | Auto-scrolls to latest assistant message |
| **`idle`** | Agent waiting at command prompt, shell waiting for input | Neutral slate | Static dot | Clean prompt composer ready for next turn |

### Optimistic UI & Interaction Guarantees
1. **Instant Turn Echo (< 16ms)**: When submitting a prompt, Orbit injects an optimistic user turn bubble and a thinking wave immediately before the network roundtrip completes.
2. **Action Morphing**: Tapping an approval button morphs into a checkmark (`✓ Approved`), disables sibling actions, and dismisses the action deck optimistically.
3. **Inertial TUI Touch Scrolling**: In CLI mode with alternate screen buffers (vim, less, ink prompts), touch drag gestures generate coalesced arrow key escapes (`\x1b[A` / `\x1b[B`) for natural touch scrolling.
4. **Security & Redaction**: All API keys, authorization tokens, private keys, and credential blocks are automatically redacted across transcript bubbles, thinking logs, and tool outputs before reaching the client.
