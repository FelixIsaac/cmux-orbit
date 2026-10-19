import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHookSessions, parseTranscriptFile, resolveTranscriptPath } from "../src/server/transcriptEngine";

describe("transcriptEngine", () => {
  test("parses Claude Code, Grok CLI, Codex, Pi, and Antigravity JSONL lines cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-test-"));
    const file = join(dir, "mixed.jsonl");

    const lines = [
      // Claude user + assistant + tool_use + tool_result
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "Check the git status" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [
            { type: "thinking", thinking: "Let me run git status." },
            { type: "text", text: "I will check the repository status." },
            {
              type: "tool_use",
              id: "tu1",
              name: "Bash",
              input: { command: "git status -s" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: "M src/index.ts",
            },
          ],
        },
      }),
      // Grok user (<user_query>) + reasoning + assistant
      JSON.stringify({
        type: "user",
        content: [
          {
            type: "text",
            text: "<user_info>OS: macos</user_info><user_query>Summarize HitPay vs Airwallex</user_query>",
          },
        ],
      }),
      JSON.stringify({
        type: "reasoning",
        id: "r1",
        summary: [{ type: "summary_text", text: "Comparing fee structures." }],
      }),
      JSON.stringify({
        type: "assistant",
        content: "HitPay focuses on ASEAN PayNow/QR while Airwallex excels at multi-currency treasury.",
      }),
    ];

    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const messages = parseTranscriptFile(file);

    expect(messages.length).toBe(4);
    expect(messages[0].role).toBe("user");
    expect(messages[0].text).toBe("Check the git status");

    expect(messages[1].role).toBe("assistant");
    expect(messages[1].thinking).toContain("Let me run git status.");
    expect(messages[1].toolCalls.length).toBe(1);
    expect(messages[1].toolCalls[0].name).toBe("Bash");
    expect(messages[1].toolCalls[0].output).toBe("M src/index.ts");

    expect(messages[2].role).toBe("user");
    expect(messages[2].text).toBe("Summarize HitPay vs Airwallex");

    expect(messages[3].role).toBe("assistant");
    expect(messages[3].thinking).toContain("Comparing fee structures.");
    expect(messages[3].text).toContain("HitPay focuses on ASEAN");

    rmSync(dir, { recursive: true, force: true });
  });

  test("loads live hook sessions from ~/.cmuxterm", () => {
    const { bySessionId } = loadHookSessions();
    expect(bySessionId.size).toBeGreaterThan(0);
  });

  test("resolveTranscriptPath rejects history.jsonl and resolves canonical brain logs", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-agy-test-"));
    const fakeHistory = join(dir, "history.jsonl");
    writeFileSync(fakeHistory, '{"conversationId":"test-sid"}\n');

    const vaultMap = new Map([["test-sid", fakeHistory]]);
    // Should NOT resolve to history.jsonl even if present in vaultMap
    const resolved = resolveTranscriptPath("test-sid", "antigravity", vaultMap);
    expect(resolved).not.toBe(fakeHistory);

    rmSync(dir, { recursive: true, force: true });
  });

  test("parses Antigravity USER_INPUT, PLANNER_RESPONSE, and GENERIC outputs cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-agy-turns-"));
    const file = join(dir, "transcript.jsonl");

    const lines = [
      JSON.stringify({
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-10-19T08:00:00Z",
        content: "<CONTEXT_SUMMARY>Old compressed history</CONTEXT_SUMMARY>\n<USER_REQUEST>Fix the transcript resolution bug</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-19T08:00:05Z",
        thinking: "Need to check transcriptEngine.ts",
        content: "I will inspect the file and fix the path resolution.",
        tool_calls: [
          {
            id: "call-1",
            name: "view_file",
            arguments: {
              AbsolutePath: "/path/to/transcriptEngine.ts",
              toolSummary: "View file",
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-10-19T08:00:06Z",
        content: "File contents: export function resolveTranscriptPath...",
      }),
    ];

    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const msgs = parseTranscriptFile(file, "antigravity");

    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].text).toBe("Fix the transcript resolution bug");

    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].thinking).toBe("Need to check transcriptEngine.ts");
    expect(msgs[1].text).toBe("I will inspect the file and fix the path resolution.");
    expect(msgs[1].toolCalls.length).toBe(1);
    expect(msgs[1].toolCalls[0].name).toBe("view_file");
    expect(msgs[1].toolCalls[0].summary).toBe("View file");
    expect(msgs[1].toolCalls[0].input).toContain("/path/to/transcriptEngine.ts");
    expect(msgs[1].toolCalls[0].output).toContain("File contents: export function resolveTranscriptPath");

    rmSync(dir, { recursive: true, force: true });
  });
});
