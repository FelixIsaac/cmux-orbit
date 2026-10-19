import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isMediaSafeAndAllowed, MEDIA_DIR } from "../src/server/workspaceInspector";
import { cleanSessionTitle } from "../src/server/stateAggregator";

describe("Media & Vault Sanitization", () => {
  test("cleanSessionTitle strips Grok rules XML and extracts clean user prompt", () => {
    const rawGrokRules = `<rules>
The rules section has a number of possible rules/memories/context that you should consider.
<user_rules>
<user_rule>Always verify before completing</user_rule>
</user_rules>
</rules>`;
    const cleaned = cleanSessionTitle(rawGrokRules, "grok", "/tmp");
    expect(cleaned).toBe("GROK session in tmp");

    const queryWithRules = `<rules>something</rules>\n<user_query>\nFix the broken authentication modal and verify in browser\n</user_query>`;
    const cleanedQuery = cleanSessionTitle(queryWithRules, "grok", "/Users/felix/Projects");
    expect(cleanedQuery).toBe("Fix the broken authentication modal and verify in browser");
  });

  test("cleanSessionTitle clamps long titles and handles Untitled fallbacks", () => {
    expect(cleanSessionTitle("", "claude", "/Users/felix/Projects/orbit")).toBe("CLAUDE session in orbit");
    expect(cleanSessionTitle("Untitled chat", "claude", "/Users/felix/LifeOS")).toBe("CLAUDE session in LifeOS");

    const veryLong = "A".repeat(200);
    const cleaned = cleanSessionTitle(veryLong, "claude", "/tmp");
    expect(cleaned.length).toBeLessThanOrEqual(160);
    expect(cleaned.endsWith("…")).toBe(true);
  });

  test("isMediaSafeAndAllowed permits temporary media and workspace assets", () => {
    expect(isMediaSafeAndAllowed("/tmp/cmux-orbit-media/screenshot.png").ok).toBe(true);
    expect(isMediaSafeAndAllowed("/var/folders/4s/1gt1n6qd5xv5r2syyr2cfhm80000gn/T/clipboard-123.png").ok).toBe(true);
    expect(isMediaSafeAndAllowed(join(homedir(), "Projects/app/icon.svg")).ok).toBe(true);
    expect(isMediaSafeAndAllowed("/tmp/document.pdf").ok).toBe(true);
  });

  test("isMediaSafeAndAllowed strictly blocks sensitive directories and executables", () => {
    expect(isMediaSafeAndAllowed("/etc/passwd").ok).toBe(false);
    expect(isMediaSafeAndAllowed(join(homedir(), ".ssh/id_rsa")).ok).toBe(false);
    expect(isMediaSafeAndAllowed(join(homedir(), ".aws/credentials")).ok).toBe(false);
    expect(isMediaSafeAndAllowed("/tmp/malicious.sh").ok).toBe(false);
    expect(isMediaSafeAndAllowed("/tmp/script.exe").ok).toBe(false);
    expect(isMediaSafeAndAllowed(join(homedir(), "Projects/.env")).ok).toBe(false);
  });

  test("POST /api/upload and GET /api/media upload and retrieve media securely", async () => {
    const { startOrbitServer } = await import("../src/server/index");
    const testPort = 4455;
    const server = startOrbitServer(testPort);

    try {
      const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
      const samplePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
      const formData = new FormData();
      formData.append("file", new File([samplePng], "test-snap.png", { type: "image/png" }));

      const uploadRes = await fetch(`http://127.0.0.1:${testPort}/api/upload`, {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${testPort}`,
        },
        body: formData,
      });

      expect(uploadRes.status).toBe(200);
      const uploadJson = await uploadRes.json();
      expect(uploadJson.ok).toBe(true);
      expect(uploadJson.filePath).toContain("media-");
      expect(uploadJson.filePath.endsWith(".png")).toBe(true);
      expect(uploadJson.previewUrl).toContain("/api/media?path=");

      // Fetch via GET /api/media
      const mediaRes = await fetch(`http://127.0.0.1:${testPort}${uploadJson.previewUrl}`);
      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await mediaRes.arrayBuffer());
      expect(bytes[0]).toBe(137);
      expect(bytes[1]).toBe(80); // P
      expect(bytes[2]).toBe(78); // N
      expect(bytes[3]).toBe(71); // G

      // Clean up uploaded test file
      if (existsSync(uploadJson.filePath)) {
        unlinkSync(uploadJson.filePath);
      }
    } finally {
      server.stop(true);
    }
  });
});
