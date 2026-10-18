import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHookSessions, parseTranscriptFile } from "../src/server/transcriptEngine";

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
});
