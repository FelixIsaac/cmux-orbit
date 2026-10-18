import { describe, expect, test } from "bun:test";
import {
  analyzeScreenText,
  detectTuiPrompt,
  extractTelemetry,
} from "../src/server/screenAnalyzer";

describe("screenAnalyzer", () => {
  test("detects Claude Code numbered permission prompt", () => {
    const screen = `
⏺ Bash(git push origin feat/orbit)
  Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for git push commands in /Users/felix/Projects/cmux-orbit
  3. No, and tell Claude what to do differently (esc)
`;
    const prompt = detectTuiPrompt(screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("numbered");
    expect(prompt?.options.length).toBe(3);
    expect(prompt?.options[0].key).toBe("1");
    expect(prompt?.options[0].isSelected).toBe(true);
    expect(prompt?.options[0].style).toBe("primary");
    expect(prompt?.options[2].style).toBe("danger");
  });

  test("detects binary (y/n) confirmation prompt", () => {
    const screen = `
Are you sure you want to overwrite config.json? (y/n)
`;
    const prompt = detectTuiPrompt(screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("binary");
    expect(prompt?.options.map((o) => o.key)).toEqual(["y", "n"]);
  });

  test("detects active streaming busy state with esc to interrupt", () => {
    const screen = `
✻ Thinking… (14s · ↓ 420 tokens · esc to interrupt)
`;
    const prompt = detectTuiPrompt(screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("busy");
    expect(prompt?.options[0].key).toBe("escape");
  });

  test("extracts Claude Code custom statusline telemetry and subagent waves", () => {
    const lines = [
      "  Opus 5.5 (high) | 3.7k t/s | SID: a7e7b95a-ccdb-442e-997b-7bf2e772dbb4",
      "  ctx: ▓▓▓▓░░░░░░ 37.5% | cmpct: ↻ 10 | blk: 49m",
      "  cost: $48.70 │ burn:$0.404/m │ 76 lines/$ │ today: $380.78 ×3",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
      "  ◯ REG   Registrar wave 8                                                         idle",
      "  ◯ L137  RAG eval v2.4 + Telegram ids 456                    12m 32s · ↓ 175.6k tokens",
    ];
    const telemetry = extractTelemetry(lines);
    expect(telemetry).not.toBeNull();
    expect(telemetry?.model).toBe("Opus 5.5 (high)");
    expect(telemetry?.sessionId).toBe("a7e7b95a-ccdb-442e-997b-7bf2e772dbb4");
    expect(telemetry?.contextPercent).toBe("37.5%");
    expect(telemetry?.costSession).toBe("$48.70");
    expect(telemetry?.costToday).toBe("$380.78");
    expect(telemetry?.subagents.length).toBe(2);
    expect(telemetry?.subagents[0].id).toBe("REG");
    expect(telemetry?.subagents[1].id).toBe("L137");
  });

  test("extracts detected file paths and filters noisy statusbar lines", () => {
    const raw = `
Updated /Users/felix/dax-fresh/proposals/BUILD-PLAN-ALL-DOORS-2026-10-01.md and src/server/index.ts
Opus 5.5 (high) | 3.7k t/s | SID: a7e7b95a-ccdb-442e-997b-7bf2e772dbb4
ctx: ▓▓▓▓░░░░░░ 37.5% | cmpct: ↻ 10 | blk: 49m
`;
    const res = analyzeScreenText(raw);
    expect(res.detectedFiles).toContain(
      "/Users/felix/dax-fresh/proposals/BUILD-PLAN-ALL-DOORS-2026-10-01.md"
    );
    expect(res.detectedFiles).toContain("src/server/index.ts");
    expect(res.liveProseSnippet).not.toContain("SID: a7e7b95a");
  });

  test("detects arrow-key menus without numbers", () => {
    const screen = `
Allow execution of git push?
❯ Allow once
  Allow always for this session
  Deny
`;
    const prompt = detectTuiPrompt(screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("numbered");
    expect(prompt?.options.length).toBe(3);
    expect(prompt?.options[0].label).toBe("Allow once");
    expect(prompt?.options[0].isSelected).toBe(true);
    expect(prompt?.options[2].label).toBe("Deny");
    expect(prompt?.options[2].style).toBe("danger");
  });

  test("detects multiline binary prompt with [y/N]", () => {
    const screen = `
Do you want to discard unsaved workspace changes?
[y/N]
`;
    const prompt = detectTuiPrompt(screen);
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe("binary");
    expect(prompt?.title).toBe("Do you want to discard unsaved workspace changes?");
    expect(prompt?.options[1].isSelected).toBe(true); // 'N' was capital, so default is No
  });
});
