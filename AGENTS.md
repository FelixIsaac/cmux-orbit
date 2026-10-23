# `cmux-orbit` — Engineering Manifesto, Product Principles, and Data State Architecture

This document is the **authoritative engineering manifesto and technical guide** for human engineers and AI coding agents working on `cmux-orbit`.

It codifies:
1. **The Four Foundational Engineering Tenets** (How to build, debug, and verify without making assumptions)
2. **The "It Just Works" Product Philosophy** (Universal input ergonomics, platform-native polish, and first-class parity)
3. **Agent & Model Detection Architecture** (How sessions identify models, agents, tokens, and telemetry)
4. **Resilience, Memory Bounding & Network Degradation** (Limits, sliding windows, caching, and reconnects)
5. **On-Disk Data State & Multiplexer Protocol Catalog** (Ground-truth filesystem inventory for Claude, Grok, Codex, Pi, Antigravity, and cmux)
6. **End-to-End Lifecycle Representation** (State flow from PTY to UI subcomponents and back)
7. **The Agent Setup Blueprint** (The canonical quote-block for setting up `cmux-orbit` inside cmux)

---

## 1. The Four Foundational Engineering Tenets

Whenever an agent builds or modifies software in this repository, it MUST adhere to these four principles. **Never skip a step. Never guess.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       The 4 Core Engineering Tenets                         │
├───────────────────────────────┬─────────────────────────────────────────────┤
│ 1. Check Documentation        │ Ground truth in upstream specs & manuals    │
│ 2. Check the Data State       │ Zero assumptions: inspect live disk/sockets │
│ 3. Analyze Code Implications  │ Audit parsing, regexes, and edge-cases      │
│ 4. End-to-End Representation  │ Faithfully trace states across lifecycles   │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

### Tenet 1: Check Documentation First
* **Rule**: Never hallucinate CLI flags, protocol schemas, framework capabilities, or system conventions. Look up the upstream documentation, source headers, help text, or API specifications before writing code.
* **In Practice**:
  * For `cmux`: Run `cmux --help`, inspect `cmux.sock` JSON-RPC schemas via test queries, and read `/Applications/cmux.app/Contents/Resources/`.
  * For Apple platforms: Consult WWDC design specifications (`apple-design` skill), `UserNotifications`, `ActivityKit`, `WidgetKit`, `Network.framework`, and `AppKit` APIs.
  * For Agent CLIs: Check the CLI help flags, hook interfaces, and upstream issues (e.g. Claude Code wrapper options, Grok CLI arguments).

### Tenet 2: Check the Data State and Make Zero Assumptions
* **Rule**: Ground truth lives in the actual runtime state on disk, in sockets, and in memory—not in what you assume "should" be there.
* **In Practice**:
  * **Inspect live files**: View the actual contents of `~/.cmuxterm/*.json`, `~/.claude/projects/`, `~/.gemini/antigravity-cli/brain/`, `~/.grok/`, `~/.codex/`, and `~/.pi/`.
  * **Never confuse indices with transcripts**: For example, `~/.gemini/antigravity-cli/history.jsonl` contains only prompt submission timestamps and workspace paths—it is **NOT** a conversation transcript. The real transcript is in `brain/<conversation-id>/.system_generated/logs/transcript.jsonl`. Assuming `history.jsonl` was a transcript broke message rendering in early iterations.
  * **Verify data before writing parsers**: Print raw lines from active sessions, test edge-case JSONL structures, inspect raw terminal screen buffers (`cmux rpc surface.read_text`), and verify actual types.

### Tenet 3: Analyze Code Implications, Parsing & Transforms
* **Rule**: When parsing or transforming data, trace every implication of your logic on all supported environments and edge cases.
* **In Practice**:
  * **Sanitization & Cleansing**: When stripping system prompts or metadata (`<rules>`, `<CONTEXT_SUMMARY>`, `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`), ensure regexes do not truncate user prose or drop messages during context truncation.
  * **Error Boundaries & Fallbacks**: If a JSONL line is mid-write during agent streaming, handle `JSON.parse` failures gracefully without crashing the poll loop or dropping the session.
  * **Optimistic Rollbacks**: If an optimistic action (e.g. 1-tap tool approval or prompt send) fails upstream, ensure the UI rolls back cleanly and alerts the user rather than leaving the interface in a desynced state.

### Tenet 4: Guarantee Representative Lifecycle Across All Subcomponents
* **Rule**: Ensure the state of every agent, workspace, tool call, and turn is faithfully represented throughout the complete lifecycle of all subcomponents.
* **In Practice**:
  * **Trace Data Flow Bi-Directionally**:
    $$\text{PTY / Agent Process} \longrightarrow \text{cmux Socket / Hook Registry} \longrightarrow \text{State Aggregator} \longrightarrow \text{WebSocket / REST} \longrightarrow \text{UI Stream / HUD / Widgets}$$
  * And backwards:
    $$\text{User Touch / Key / Notification Action} \longrightarrow \text{Client Action} \longrightarrow \text{API / Unix Socket} \longrightarrow \text{cmux Focus / Key Injection} \longrightarrow \text{PTY}$$
  * A surface transitioning to `needs_input` must simultaneously:
    1. Update the Mission Control triage card with an amber attention ring and 1-tap choice pills.
    2. Update the surface tab with an amber indicator dot.
    3. Trigger a system notification with native `[1] Approve`, `[2] Always`, `[Esc] Deny` buttons.
    4. Update the macOS Menu Bar Extra badge and Dock tile count.
    5. Update the iOS Live Activity banner and Dynamic Island state.
    6. Update Lock Screen and Home Screen widgets.
  * If any subcomponent drops or misrepresents this state, the lifecycle is broken.

---

## 2. The "It Just Works" Product Philosophy

Every feature in `cmux-orbit` must adhere to an uncompromising standard of usability: **if a user expects something to work, it must work seamlessly across every device and surface.**

### A. Universal Input Ergonomics
* **The Rule of Text Inputs**: If there is an input field anywhere in the application (composer dock, Quick HUD bar, or modal):
  * **Desktop (macOS / Web)**: Pasting an image (`⌘V`), dropping an image file, or typing text must immediately attach and preview the image in an attachment shelf with a remove button and size badge.
  * **Mobile (iOS / Android)**: Tapping the image icon or pasting from the system clipboard must upload the image to `/api/upload` via `POST`, render a thumbnail card in the attachment shelf, and automatically inject the local asset path into the agent prompt context.
  * **Keyboard & Viewport Freedom**: On mobile Safari, the composer dock must pin flush above the virtual keyboard via `window.visualViewport` without jitter, layout shift, or obscuring the conversation.

### B. First-Class Parity Across All Agents
* No agent is a second-class citizen:
  * **Claude Code (`claude`)**: Full transcript parsing, thinking blocks, subagent waves, statusline telemetry, and numbered Ink TUI approvals (`[1] Yes [2] Always [3] No`).
  * **Grok CLI (`grok`)**: Title sanitization (stripping `<rules>` tags), reasoning summaries, updates JSONL streaming, and prompt approvals.
  * **OpenAI Codex (`codex`)**: Turn ledger tracking, function call input/output pairing, and rollout transcripts.
  * **Pi Agent (`pi`)**: Message role normalization, tool execution tracking, and session resolution.
  * **Google Antigravity (`agy` / `ag`)**: Native brain transcript parsing (`transcript.jsonl` / `transcript_full.jsonl`), `USER_INPUT` / `PLANNER_RESPONSE` decomposition, tool output linking from `GENERIC` steps, and session resumption.
  * **Raw Shells (`zsh`, `bash`)**: Live TrueColor ANSI reconstruction, alternate buffer touch gestures, command execution (`! <cmd>`), and terminal key strips.

### C. Platform-Native Fidelity (Respecting the Operating System)
Rather than forcing a generic web container everywhere, `cmux-orbit` embraces platform-native capabilities:

```
┌─────────────────────────────────┬───────────────────────────────────────────┐
│ Platform                        │ Native Superpowers Exploited              │
├─────────────────────────────────┼───────────────────────────────────────────┤
│ macOS Native (`CmuxOrbitMac`)   │ • Menu Bar Extra (`MenuBarExtra`)         │
│                                 │ • Spotlight Floating HUD (`⌘⇧O`)          │
│                                 │ • Interactive Notification Approvals      │
│                                 │ • Dynamic Dock Tile Badging               │
│                                 │ • Direct Unix Socket IPC (`cmux.sock`)    │
├─────────────────────────────────┼───────────────────────────────────────────┤
│ iOS Native (`CmuxOrbitIOS`)     │ • Dynamic Island & Live Activities        │
│                                 │ • Lock Screen & Home Screen Widgets       │
│                                 │ • Tactile Haptics (`UIImpactFeedback`)    │
│                                 │ • Native SwiftUI with 44pt+ touch targets │
├─────────────────────────────────┼───────────────────────────────────────────┤
│ Mobile Web / PWA                │ • Zero-Expiry Home Screen PWA             │
│                                 │ • Visual Viewport Keyboard Pinning        │
│                                 │ • Inertial Touch TUI Pager Scrolling      │
│                                 │ • Instant Local Optimistic Echo (< 16ms)  │
└─────────────────────────────────┴───────────────────────────────────────────┘
```

---

## 3. Agent & Model Detection Architecture

How does `cmux-orbit` know what model and agent are running in each session?

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Three-Tier Model Detection Pipeline                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Tier 1: Real-Time Statusline Scraping (`screenAnalyzer.ts`)                 │
│         Scrapes live model strings (e.g. "claude-sonnet-5-5",               │
│         "claude-opus-4-0", "Gemini 2.5", "Grok-Beta") and context % from    │
│         the bottom rows of the active terminal PTY.                         │
│                                                                             │
│ Tier 2: Agent Hook Session Registries (`~/.cmuxterm/*.json`)                │
│         Inspects metadata emitted by cmux wrappers: model overrides,        │
│         permission modes, session UUIDs, and tool registries.               │
│                                                                             │
│ Tier 3: Structured Transcript Headers (`transcriptEngine.ts`)               │
│         Extracts model identifiers from native JSONL headers                │
│         (e.g. Anthropic API model parameter, Codex payload model, or       │
│         Antigravity step metadata).                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Telemetry Displayed
* **Model Badge**: Displayed in the surface header and telemetry chips (e.g., `Opus 5.5`, `Claude 3.7 Sonnet`, `Antigravity`).
* **Context Fill Percentage**: Scraped directly from statuslines (e.g., `38%` context consumed).
* **Cost & Burn Rate**: Real-time session and daily cost (e.g., `$1.42 session`, `$0.08/min`).
* **Active Subagents**: Live wave tracker for subagents (e.g., `◯ REG`, `◯ L137`).

---

## 4. Resilience, Memory Bounding & Network Degradation

Coding agents can run for days, emit hundreds of thousands of words, and execute across changing networks. `cmux-orbit` is engineered to never crash, freeze, or drop state under high load:

### A. Network Disconnection & Sleep Recovery
* **The Problem**: You close your MacBook lid, walk away, switch from Wi-Fi to 5G, or experience high latency over Tailscale.
* **The Solution**:
  1. **Heartbeat & Liveness**: The WebSocket multiplexer maintains ping/pong heartbeats. Upon socket termination, the client triggers exponential backoff reconnection.
  2. **Watch Resubscription**: On reconnect, the client immediately transmits `{"type": "watch", "surfaceId": "..."}` to rebind to the active surface and pulls a fresh dashboard snapshot.
  3. **Optimistic Rollback**: Unconfirmed turns or actions display a pending indicator and rollback cleanly if the connection drops before confirmation.

### B. Conversation Windowing & Memory Bounding
* **The Problem**: A multi-day agent session with 3,000+ turns and megabytes of JSONL will crash mobile Safari if rendered completely into the DOM.
* **The Solution**:
  1. **Sliding Window Rendering**: Orbit renders only the most recent **40 turns** by default.
  2. **Pagination on Demand**: A clean **"Load earlier turns (N remaining)"** button at the top of the conversation stream allows users to page through historical turns on demand without thrashing DOM memory.
  3. **Terminal Tail Bounding**: When falling back to raw terminal view, xterm.js scrollback is clamped to 1,000 lines on mobile to preserve memory.

### C. Scalability: 50 Workspaces & 50 Tabs
* **Mission Control Grouping**: Workspaces are partitioned into priority buckets (`Needs Your Input`, `Running`, `Unread`, `Idle`).
* **Compact Horizontal Surface Tabs**: Surface tabs are scrollable with smooth touch momentum and do not trigger layout shifts during tab switching.
* **Data Hashing**: The server transmits diff hashes of dashboard snapshots, preventing redundant JSON serialization and unnecessary DOM repaints.

---

## 5. On-Disk Data State Catalog (Ground Truth Inventory)

Below is the verified schema and filesystem layout for every supported agent environment on disk:

### 1. Google Antigravity (`agy` / `ag`)
* **Root Directory**: `~/.gemini/antigravity-cli/`
* **Command Index / History**: `~/.gemini/antigravity-cli/history.jsonl`
  * *Format*: JSON Lines containing user prompt submissions and metadata:
    ```json
    {"display":"fix the build","timestamp":1792370000000,"workspace":"/Users/felix/Projects","conversationId":"41294be6-8056-4992-aad2-320b241c730c"}
    ```
  * *CRITICAL INVARIANT*: `history.jsonl` is **NOT** a conversation transcript; it does not contain assistant responses, reasoning, or tool outputs. `cmux-orbit` explicitly rejects `history.jsonl` as a transcript candidate.
* **Canonical Transcripts**:
  * Compact: `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
  * Full (untruncated): `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
  * *Line Schemas*:
    * `USER_INPUT`:
      ```json
      {
        "step_index": 1,
        "source": "USER_EXPLICIT",
        "type": "USER_INPUT",
        "created_at": "2026-10-19T08:00:00Z",
        "content": "<CONTEXT_SUMMARY>...</CONTEXT_SUMMARY>\n<USER_REQUEST>Fix the UI</USER_REQUEST>"
      }
      ```
    * `PLANNER_RESPONSE`:
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
    * `GENERIC` (Tool Execution Result):
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
* **SQLite Stores**: `~/.gemini/antigravity-cli/conversations/<uuid>.db` (local cache) and `conversation_summaries.db`.

### 2. Claude Code (`claude`)
* **Hook Sessions**: `~/.cmuxterm/claude-hook-sessions.json`
  * *Schema*:
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
* **Canonical Transcripts**: `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`
  * *Path Encoding*: `/Users/felix/Projects` → `~/.claude/projects/-Users-felix-Projects/<sessionId>.jsonl`
  * *Line Types*: `type: "user"`, `type: "assistant"`, `type: "tool_use"`, `type: "tool_result"`, `type: "thinking"`.

### 3. Grok CLI (`grok`)
* **Hook Sessions**: `~/.cmuxterm/grok-hook-sessions.json`
* **Canonical Transcripts**: `~/.grok/sessions/<workspace>/<sessionId>/updates.jsonl` and `chat_history.jsonl`
  * *Line Types*: `type: "user"` (with `<user_query>` inside `content`), `type: "reasoning"` (thinking summary), `type: "assistant"`, `type: "tool_result"`.

### 4. OpenAI Codex (`codex`)
* **Hook Sessions**: `~/.cmuxterm/codex-hook-sessions.json`
* **Ledgers**: `~/.cmuxterm/codex-turn-ledger.json`
* **Canonical Transcripts**: `~/.codex/sessions/**/<sessionId>*.jsonl` / `rollout-*.jsonl`
  * *Line Types*: `type: "response_item"` with `payload.type: "message"`, `payload.type: "function_call"`, `payload.type: "function_call_output"`.

### 5. Pi Agent (`pi`)
* **Hook Sessions**: `~/.cmuxterm/pi-hook-sessions.json`
* **Canonical Transcripts**: `~/.pi/agent/sessions/*/*<sessionId>.jsonl`
  * *Line Types*: `type: "message"` with `message.role: "user" | "assistant" | "toolResult"`.

### 6. Interactive Shell (`zsh` / `bash`)
* Virtual terminal PTY with no structured transcript on disk.
* Captured dynamically via cmux RPCs `terminal.replay` and `surface.read_text`.

---

## 6. End-to-End Lifecycle Representation Across Subcomponents

Orbit reflects the complete lifecycle of agents across every interface element:

| Lifecycle State | Trigger / Origin | Mission Control Card | Surface Tab | Conversation View | macOS HUD / Menu Bar | iOS Live Activity |
|---|---|---|---|---|---|---|
| **`needs_input`** | TUI permission prompt (`[1] Yes [2] No`), human obligation in cmux, or hook state `needs_input` | Amber pulsing badge, pinned to triage bucket | Amber dot, active tab focus | Sticky Thumb-Action Sheet (`[1] Yes`, `[2] No`, `[Esc] Cancel`) | `bell.badge.fill` icon, badge counter, 1-tap Approve/Deny buttons | Lock Screen card + Dynamic Island orange indicator with prompt snippet |
| **`running`** | Streaming delta, active tool execution, or statusline busy indicator | Blue pulsing ring, active turn excerpt | Blue pulsing dot | Animated thinking wave, live tool call disclosure | `bolt.fill` active icon | Dynamic Island expanded view with elapsed time & active tool |
| **`unread`** | Agent finished turn with new assistant content while surface unfocused | Cyan unread ring | Cyan badge | Auto-scrolls to latest assistant message | Unread turn badge counter | Notification banner on completion |
| **`idle`** | Agent waiting at command prompt, shell waiting for input | Neutral slate | Static dot | Clean prompt composer ready for next turn | Standard `terminal.fill` icon | Minimal compact status |

---

## 7. Host Network & Security Architecture

1. **Loopback-Only Service Binding**:
   - `cmux-orbit` binds strictly to `127.0.0.1:4400` (`ORBIT_HOST=127.0.0.1`).
   - It is never directly bound to `0.0.0.0`, eliminating exposure on untrusted local LANs, hotels, cafes, or public Wi-Fi.
2. **Tailscale Ingress Proxying**:
   - Remote access from mobile devices (e.g., iPhone) routes through `tailscale serve` (e.g. `tcp://100.64.0.26:4400 -> tcp://127.0.0.1:4400`).
   - Peer address validation (`isTrustedClientIp`) permits loopback (`127.0.0.1`, `::1`) and Tailscale CGNAT mesh ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`).
   - IPv6 link-local addresses (`fe80:`) are explicitly rejected as untrusted.
3. **Hardened Host Environment**:
   - SSH access on the host Mac is strictly key-only (`PasswordAuthentication no`).
   - **Third-Party Relay Policy**: `cmux-relay` (from upstream `NewTurn2017/cmux-remote`) is locked down to `127.0.0.1:4399` and exposed only to the tailnet via `tailscale serve --tcp 4399 tcp://127.0.0.1:4399`. It is completely unreferenced by `cmux-orbit` code. Agents must **NEVER** modify, kill, restart, or alter `cmux-relay` configuration without explicit user instruction.
4. **Stable LaunchAgent Runtime Resolution**:
   - The LaunchAgent plist template and installer (`scripts/install-launchd.sh`, `./bin/cmux-orbit install-service`) resolve the stable Homebrew opt binary path (`/opt/homebrew/opt/bun/bin/bun` or `$(brew --prefix bun)/bin/bun`), never pinning to a transient Cellar directory (`Cellar/bun/1.4.x/bin/bun`) that breaks on subsequent `brew upgrade` operations.

---

## 8. The Agent Setup Blueprint (Copy-Paste Instruction Block)

When introducing a new agent or developer to `cmux-orbit` inside `cmux`, provide them with this exact quote block to set up the entire stack with zero manual steps:

```markdown
> ### cmux-orbit Setup & Verification Instructions for Agents
> 
> 1. **Prerequisites Verification**:
>    - Ensure `cmux` is running on your Mac with socket control enabled:
>      Verify `~/.config/cmux/cmux.json` contains `"automation": { "socketControlMode": "allowAll" }`.
>    - Ensure `bun` is installed: `which bun` (if missing: `brew install oven-sh/bun/bun`).
>    - Ensure Tailscale is active: `/Applications/Tailscale.app/Contents/MacOS/Tailscale status`.
> 
> 2. **Start or Install the Background Service**:
>    ```bash
>    cd /Users/felix/Projects/cmux-orbit
>    
>    # Install and launch the persistent macOS background daemon on loopback (127.0.0.1:4400):
>    ./bin/cmux-orbit install-service
>    
>    # Verify the daemon is active and print your iPhone connection URL:
>    ./bin/cmux-orbit status
>    ```
> 
> 3. **Run the Automated Test Suite**:
>    ```bash
>    bun test
>    # Must pass 100% (30/30 unit, integration, and security tests).
>    ```
> 
> 4. **Build & Run the Native macOS Menu Bar & HUD Companion**:
>    ```bash
>    cd /Users/felix/Projects/cmux-orbit/native
>    
>    # Build with zero third-party dependencies:
>    swift build
>    
>    # Launch the native macOS app:
>    swift run cmux-orbit-mac
>    # (Use ⌘⇧O to summon the floating Spotlight HUD overlay anywhere).
>    ```
> 
> 5. **Connect Your iPhone / Mobile Device**:
>    - Open Safari on your phone (connected to Tailscale).
>    - Navigate to the URL printed by `./bin/cmux-orbit status` (e.g. `http://100.64.0.26:4400` via `tailscale serve`).
>    - Tap **Share (↑) → Add to Home Screen → Add**.
>    - Enjoy full Agent-First Mission Control with 1-tap TUI approvals, reflowed markdown, and multimedia paste!
```

---

## 9. Quality Checklist for Future Changes

Before submitting any commit or pull request to `cmux-orbit`:
1. [ ] **Doc Check**: Have you verified the official documentation or protocol schema for any new API?
2. [ ] **State Check**: Have you inspected the live files on disk (`~/.cmuxterm`, `~/.claude`, `~/.gemini`, etc.) to confirm schemas?
3. [ ] **Code Audit**: Does `screenAnalyzer.ts` / `transcriptEngine.ts` handle edge cases (multiline, ANSI escapes, XML tags, missing fields)?
4. [ ] **Lifecycle Fidelity**: Does state update synchronously across Mission Control, surface tabs, conversation stream, macOS Menu Bar/HUD, and iOS Live Activities?
5. [ ] **Input Ergonomics**: Can the user paste multimedia / images into the composer on both desktop and mobile?
6. [ ] **Security & Bind Verification**: Does `cmux-orbit` bind strictly to `127.0.0.1`? Are all untrusted LAN / `fe80` requests blocked? Is `cmux-relay` left untouched?
7. [ ] **Network Resilience**: Does the client reconnect gracefully after waking from sleep or switching networks?
8. [ ] **Zero Dependency Bloat**: Does `native/` compile cleanly with pure Apple frameworks and zero third-party package dependencies?
9. [ ] **Tests Green**: Does `bun test` pass 100%?
