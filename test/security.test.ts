import { describe, expect, test } from "bun:test";
import {
  escapeShellArg,
  isPathSafeAndAllowed,
  redactSecrets,
} from "../src/server/workspaceInspector";
import {
  getAllowedTailscaleLogins,
  getOrCreateOrbitAuthToken,
  isCsrfSafe,
  isTrustedClientIp,
  isValidHostHeader,
  verifyRequestAuth,
} from "../src/server/index";
import { isCmuxConnected, onCmuxConnectionChange } from "../src/server/cmuxSocket";

describe("Security & Privacy Hardening", () => {
  test("isValidHostHeader prevents DNS rebinding", () => {
    expect(isValidHostHeader("localhost")).toBe(true);
    expect(isValidHostHeader("localhost:4400")).toBe(true);
    expect(isValidHostHeader("127.0.0.1")).toBe(true);
    expect(isValidHostHeader("127.0.0.1:4400")).toBe(true);
    expect(isValidHostHeader("[::1]:4400")).toBe(true);
    expect(isValidHostHeader("100.64.0.26")).toBe(true);
    expect(isValidHostHeader("100.115.92.10:4400")).toBe(true);
    expect(isValidHostHeader("felixs-helm.ts.net")).toBe(true);
    expect(isValidHostHeader("felixs-helm")).toBe(true);
    expect(isValidHostHeader("felixs-helm:4400")).toBe(true);
    expect(isValidHostHeader("felixs-helm.hs.lint.internal")).toBe(true);
    expect(isValidHostHeader("felixs-helm.hs.lint.internal:4400")).toBe(true);

    // Rebind attacks rejected
    expect(isValidHostHeader("evil.com")).toBe(false);
    expect(isValidHostHeader("rebind.attacker.com:4400")).toBe(false);
    expect(isValidHostHeader("192.168.1.100")).toBe(false);
    expect(isValidHostHeader("")).toBe(false);
  });

  test("isTrustedClientIp verifies true loopback only (blanket tailnet IP trust removed)", () => {
    expect(isTrustedClientIp("127.0.0.1")).toBe(true);
    expect(isTrustedClientIp("::1")).toBe(true);
    expect(isTrustedClientIp("localhost")).toBe(true);

    // Blanket IP trust removed: Tailscale IPs are NOT trusted without Tailscale-User-Login or token
    expect(isTrustedClientIp("100.64.0.26")).toBe(false);
    expect(isTrustedClientIp("100.120.5.1")).toBe(false);
    expect(isTrustedClientIp("fd7a:115c:a1e0::1")).toBe(false);

    // Untrusted LAN IPs and fe80 link-local IPs are rejected
    expect(isTrustedClientIp("fe80::1")).toBe(false);
    expect(isTrustedClientIp("fe80::1a2b:3c4d:5e6f")).toBe(false);
    expect(isTrustedClientIp("192.168.1.55")).toBe(false);
    expect(isTrustedClientIp("10.0.0.42")).toBe(false);
    expect(isTrustedClientIp("8.8.8.8")).toBe(false);
  });

  test("verifyRequestAuth enforces Tailscale-User-Login allowlist, loopback trust, and token fallback", () => {
    // 1. Plain loopback request with no Tailscale header stays trusted
    const loopbackReq = new Request("http://127.0.0.1:4400/api/health");
    const loopbackAuth = verifyRequestAuth(loopbackReq, "127.0.0.1");
    expect(loopbackAuth.ok).toBe(true);
    expect(loopbackAuth.forbidden).toBeUndefined();

    // 2. Request carrying allowlisted Tailscale-User-Login is accepted
    const allowedReq = new Request("http://felixs-helm:4400/api/health", {
      headers: { "tailscale-user-login": "felix" },
    });
    const allowedAuth = verifyRequestAuth(allowedReq, "127.0.0.1");
    expect(allowedAuth.ok).toBe(true);
    expect(allowedAuth.tailscaleUser).toBe("felix");

    // 3. Request carrying non-allowlisted Tailscale-User-Login gets forbidden (403)
    const attackerReq = new Request("http://felixs-helm:4400/api/health", {
      headers: { "tailscale-user-login": "attacker@example.com" },
    });
    const attackerAuth = verifyRequestAuth(attackerReq, "127.0.0.1");
    expect(attackerAuth.ok).toBe(false);
    expect(attackerAuth.forbidden).toBe(true);
    expect(attackerAuth.error).toContain("attacker@example.com");

    const vasReq = new Request("http://felixs-helm:4400/api/health", {
      headers: { "tailscale-user-login": "vas" },
    });
    const vasAuth = verifyRequestAuth(vasReq, "127.0.0.1");
    expect(vasAuth.ok).toBe(false);
    expect(vasAuth.forbidden).toBe(true);

    // 4. Request with empty Tailscale-User-Login is rejected
    const emptyTsReq = new Request("http://felixs-helm:4400/api/health", {
      headers: { "tailscale-user-login": "   " },
    });
    const emptyTsAuth = verifyRequestAuth(emptyTsReq, "127.0.0.1");
    expect(emptyTsAuth.ok).toBe(false);
    expect(emptyTsAuth.forbidden).toBe(true);

    // 5. Non-loopback request with no header and no token requires auth token (401)
    const remoteReq = new Request("http://192.168.1.50:4400/api/health");
    const remoteAuth = verifyRequestAuth(remoteReq, "192.168.1.50");
    expect(remoteAuth.ok).toBe(false);
    expect(remoteAuth.forbidden).toBe(false);

    // 6. Non-loopback request with valid Orbit Auth Token succeeds
    const token = getOrCreateOrbitAuthToken();
    const tokenQueryReq = new Request(`http://192.168.1.50:4400/api/health?token=${token}`);
    expect(verifyRequestAuth(tokenQueryReq, "192.168.1.50").ok).toBe(true);

    const tokenHeaderReq = new Request("http://192.168.1.50:4400/api/health", {
      headers: { "x-orbit-token": token },
    });
    expect(verifyRequestAuth(tokenHeaderReq, "192.168.1.50").ok).toBe(true);
  });

  test("isCsrfSafe validates Origin and Sec-Fetch-Site", () => {
    const crossSiteReq = new Request("http://localhost:4400/api/action", {
      method: "POST",
      headers: {
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://evil.com",
      },
    });
    expect(isCsrfSafe(crossSiteReq)).toBe(false);

    const evilOriginReq = new Request("http://localhost:4400/api/action", {
      method: "POST",
      headers: {
        Origin: "https://attacker.com",
      },
    });
    expect(isCsrfSafe(evilOriginReq)).toBe(false);

    const safeReq = new Request("http://localhost:4400/api/action", {
      method: "POST",
      headers: {
        "Sec-Fetch-Site": "same-origin",
        Origin: "http://localhost:4400",
        "X-Orbit-Request": "1",
      },
    });
    expect(isCsrfSafe(safeReq)).toBe(true);
  });

  test("isPathSafeAndAllowed blocks sensitive credential files and traversal", () => {
    expect(isPathSafeAndAllowed("/etc/passwd").ok).toBe(false);
    expect(isPathSafeAndAllowed("/var/log/system.log").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/.ssh/id_rsa").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/.ssh/id_ed25519").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/.aws/credentials").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/.gnupg/secring.gpg").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/Projects/app/.env").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/Projects/app/.env.local").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/Projects/app/server.key").ok).toBe(false);
    expect(isPathSafeAndAllowed("~/Projects/app/cert.pem").ok).toBe(false);

    // Safe user workspace path
    expect(isPathSafeAndAllowed("~/Projects/cmux-orbit/README.md").ok).toBe(true);
  });

  test("escapeShellArg safely escapes arbitrary shell inputs", () => {
    expect(escapeShellArg("/tmp/simple")).toBe("'/tmp/simple'");
    expect(escapeShellArg("/tmp/with 'quotes'")).toBe("'/tmp/with '\\''quotes'\\'''");
    expect(escapeShellArg("/tmp/`whoami`")).toBe("'/tmp/`whoami`'");
    expect(escapeShellArg("/tmp/$(rm -rf /)")).toBe("'/tmp/$(rm -rf /)'");
  });

  test("redactSecrets masks API keys, tokens, and private keys", () => {
    const raw = `
      export ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890abcdef1234567890
      export OPENAI_API_KEY=sk-proj-9876543210zyxwvutsrqponmlkjihgfedcba
      export GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz
      Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID5umQrQ98CQ
      -----BEGIN RSA PRIVATE KEY-----
      MIIEowIBAAKCAQEA0Y...
      -----END RSA PRIVATE KEY-----
    `;

    const sanitized = redactSecrets(raw);
    expect(sanitized).not.toContain("sk-ant-api03");
    expect(sanitized).not.toContain("sk-proj-9876543210");
    expect(sanitized).not.toContain("ghp_1234567890");
    expect(sanitized).not.toContain("MIIEowIBAAKCAQEA0Y");
    expect(sanitized).toContain("[REDACTED SECRET]");
  });

  test("cmux connection management tracks online status", () => {
    let notified = false;
    const unsub = onCmuxConnectionChange((connected) => {
      notified = true;
    });
    expect(typeof isCmuxConnected()).toBe("boolean");
    unsub();
  });
});
