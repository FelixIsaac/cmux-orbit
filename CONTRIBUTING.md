# Contributing to `cmux-orbit`

Thank you for your interest in contributing to **`cmux-orbit`**! This document provides the guidelines, standards, and workflow for maintaining and extending this codebase sustainably.

---

## 1. The Four Foundational Tenets

Before making any changes or proposing architectural decisions, read [`AGENTS.md`](./AGENTS.md). All work must respect these four core tenets:

1. **Check Documentation First**: Ground truth in official manuals, protocol specifications, and CLI references. Never guess API shapes, flags, or endpoints.
2. **Check the Data State & Make Zero Assumptions**: Inspect real runtime files on disk (`~/.cmuxterm`, `~/.claude`, `~/.gemini`, `~/.grok`, `~/.codex`, `~/.pi`, `cmux.sock`).
3. **Analyze Code Implications, Parsing & Transforms**: Test regex boundaries, tag sanitizers, ANSI handling, debouncing, and optimistic rollbacks across all supported agents.
4. **Guarantee Representative Lifecycle Across All Subcomponents**: Ensure state transitions (`needs_input`, `running`, `unread`, `idle`) propagate bi-directionally across the entire stack—from the PTY to the Web UI, macOS Menu Bar, Spotlight HUD, and iOS Live Activities.

---

## 2. Development Setup

### Prerequisites
- macOS 14+ with [`cmux`](https://cmux.com) installed.
- [Bun](https://bun.sh) (`brew install oven-sh/bun/bun`).
- Xcode 15+ / Swift 5.10+ (for native companion targets).
- Optional: [Tailscale](https://tailscale.com) for remote iPhone access.

### Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/FelixIsaac/cmux-orbit.git
cd cmux-orbit

# 2. Install dependencies
bun install

# 3. Run automated tests and TypeScript typecheck
bun test
bun run typecheck

# 4. Check system health diagnostics
./bin/cmux-orbit doctor

# 5. Start development server with live reload
bun run dev
```

---

## 3. Verification & Quality Standards

Before committing any code or submitting a Pull Request, verify the following:

- [ ] **Tests Pass**: `bun test` passes 100% (unit, integration, and security tests).
- [ ] **Type Safety**: `bun run typecheck` completes with 0 errors.
- [ ] **Native Swift**: `cd native && swift build` compiles cleanly with 0 warnings.
- [ ] **Ergonomics**: Universal input ergonomics are preserved (clipboard multimedia paste, mobile touch-scrolling, visual viewport pinning).
- [ ] **Security**: All API keys, tokens, and credentials are automatically redacted; origins are verified; sensitive paths are blocked.

---

## 4. Useful CLI Commands

* `./bin/cmux-orbit doctor`: System health and configuration diagnostics.
* `./bin/cmux-orbit status`: Current daemon state, socket health, and Tailscale IP.
* `./bin/cmux-orbit logs -f`: Stream live daemon logs.
* `./bin/cmux-orbit restart`: Restart the background launchd service.
* `./bin/cmux-orbit clean-media`: Purge temporary media older than 24 hours.
* `./bin/cmux-orbit open`: Open the web dashboard in your default browser.
