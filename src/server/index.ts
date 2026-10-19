import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { cmuxRpc, CmuxEventStream, isCmuxConnected, onCmuxConnectionChange, resolveCmuxSocketPath } from "./cmuxSocket";
import {
  buildDashboardSnapshot,
  getSurfaceDetail,
  getVaultSessions,
} from "./stateAggregator";
import { parseTranscriptFile } from "./transcriptEngine";
import {
  escapeShellArg,
  formatDirectoryEntry,
  inspectGitWorkspace,
  isMediaSafeAndAllowed,
  isPathSafeAndAllowed,
  MEDIA_DIR,
  readFilePreview,
  resolveSafeFilePath,
} from "./workspaceInspector";

const PUBLIC_DIR = join(import.meta.dir, "../public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface WsClientData {
  watchedWorkspaceId?: string;
  watchedSurfaceId?: string;
  lastSurfaceHash?: string;
}

const STATE_DIR = join(homedir(), ".local/state/cmux-orbit");
const TOKEN_FILE = join(STATE_DIR, "auth_token");

let _cachedAuthToken = "";

export function getOrCreateOrbitAuthToken(): string {
  if (_cachedAuthToken) return _cachedAuthToken;
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    }
    if (existsSync(TOKEN_FILE)) {
      _cachedAuthToken = readFileSync(TOKEN_FILE, "utf8").trim();
      if (_cachedAuthToken.length >= 24) return _cachedAuthToken;
    }
    _cachedAuthToken = randomBytes(24).toString("hex");
    writeFileSync(TOKEN_FILE, _cachedAuthToken + "\n", { mode: 0o600 });
    try {
      chmodSync(TOKEN_FILE, 0o600);
    } catch {}
    return _cachedAuthToken;
  } catch {
    if (!_cachedAuthToken) {
      _cachedAuthToken = randomBytes(24).toString("hex");
    }
    return _cachedAuthToken;
  }
}

const LOCAL_HOST = hostname().toLowerCase();
const ALLOWED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  LOCAL_HOST,
  LOCAL_HOST.includes(".") ? LOCAL_HOST.split(".")[0] : `${LOCAL_HOST}.local`,
  "felixs-helm",
  "felixs-helm.local",
]);

export function isValidHostHeader(hostHeader?: string | null): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.toLowerCase().trim();
  if (host.startsWith("[")) {
    const bracketEnd = host.indexOf("]");
    if (bracketEnd !== -1) {
      host = host.slice(0, bracketEnd + 1);
    }
  } else {
    host = host.split(":")[0];
  }

  if (ALLOWED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".ts.net")) return true;
  // Tailscale IPv4 100.64.0.0/10 (100.64.x.x - 100.127.x.x)
  const parts = host.split(".").map((n) => parseInt(n, 10));
  if (parts.length === 4 && !parts.some(isNaN)) {
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  return false;
}

export function isTrustedClientIp(ip?: string | null): boolean {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
  // Tailscale IPv4 100.64.0.0/10
  const parts = clean.split(".").map((n) => parseInt(n, 10));
  if (parts.length === 4 && !parts.some(isNaN)) {
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  // Tailscale IPv6
  if (clean.startsWith("fd7a:115c:a1e0:") || clean.startsWith("fe80:")) return true;
  return false;
}

export function verifyRequestAuth(req: Request, clientIp?: string | null): { ok: boolean; setCookie?: string } {
  if (isTrustedClientIp(clientIp)) {
    return { ok: true };
  }

  const expectedToken = getOrCreateOrbitAuthToken();
  const url = new URL(req.url);

  const queryToken = url.searchParams.get("token");
  if (queryToken && queryToken === expectedToken) {
    return {
      ok: true,
      setCookie: `orbit_auth=${expectedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
    };
  }

  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7).trim() === expectedToken) {
    return { ok: true };
  }

  const tokenHeader = req.headers.get("x-orbit-token") || "";
  if (tokenHeader === expectedToken) {
    return { ok: true };
  }

  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)orbit_auth=([a-zA-Z0-9_\-]+)/);
  if (match && match[1] === expectedToken) {
    return { ok: true };
  }

  return { ok: false };
}

export function isCsrfSafe(req: Request): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const origUrl = new URL(origin);
      if (!isValidHostHeader(origUrl.host)) {
        return false;
      }
      const host = req.headers.get("host") || "";
      if (host && origUrl.host.toLowerCase() === host.toLowerCase()) {
        return true;
      }
    } catch {
      return false;
    }
  }

  const customHeader = req.headers.get("x-orbit-request") || req.headers.get("x-orbit-token");
  if (customHeader) return true;
  if (secFetchSite === "same-origin" || !origin) {
    return true;
  }
  return false;
}

function withSecurityHeaders(res: Response, extraHeaders?: Record<string, string>): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data: blob:;"
  );
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.headers.set(k, v);
    }
  }
  return res;
}

function jsonResponse(data: any, status = 200, extraHeaders?: Record<string, string>): Response {
  const res = new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
  return withSecurityHeaders(res, extraHeaders);
}

function renderAuthHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cmux-orbit Authentication</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0d13; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #151822; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 28px; max-width: 380px; width: 100%; text-align: center; }
    h2 { margin: 0 0 10px; font-size: 20px; font-weight: 700; color: #7aa2f7; }
    p { color: #8892b0; font-size: 13.5px; margin-bottom: 20px; line-height: 1.5; }
    input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #fff; font-size: 14px; box-sizing: border-box; margin-bottom: 14px; font-family: monospace; outline: none; }
    input:focus { border-color: #7aa2f7; }
    button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #7aa2f7; color: #000; font-size: 15px; font-weight: 600; cursor: pointer; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✦ cmux-orbit</h2>
    <p>Authentication is required for untrusted remote networks. Enter your Orbit Auth Token from your Mac (<code>~/.local/state/cmux-orbit/auth_token</code>):</p>
    <form method="GET" action="/">
      <input type="password" name="token" placeholder="Paste Orbit Token" required autofocus />
      <button type="submit">Authenticate</button>
    </form>
  </div>
</body>
</html>`;
}

export function startOrbitServer(port = Number(process.env.PORT || 4400)) {
  const wsClients = new Set<any>();
  const eventStream = new CmuxEventStream();
  eventStream.start();

  getOrCreateOrbitAuthToken();

  let broadcastDebounce: any = null;
  let broadcastPending = false;
  const triggerDashboardBroadcast = () => {
    if (broadcastDebounce) {
      broadcastPending = true;
      return;
    }
    broadcastDebounce = setTimeout(async () => {
      broadcastDebounce = null;
      if (wsClients.size > 0) {
        try {
          const snapshot = await buildDashboardSnapshot(true);
          const payload = JSON.stringify({ type: "dashboard", data: snapshot });
          for (const ws of wsClients) {
            try {
              if (ws.bufferedAmount < 256 * 1024) ws.send(payload);
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }
      if (broadcastPending) {
        broadcastPending = false;
        triggerDashboardBroadcast();
      }
    }, 350);
  };

  const surfaceActionQueues = new Map<string, Promise<any>>();
  function enqueueSurfaceAction<T>(surfaceId: string, task: () => Promise<T>): Promise<T> {
    const current = surfaceActionQueues.get(surfaceId) || Promise.resolve();
    const next = current.then(task, task);
    surfaceActionQueues.set(surfaceId, next);
    next.finally(() => {
      if (surfaceActionQueues.get(surfaceId) === next) {
        surfaceActionQueues.delete(surfaceId);
      }
    });
    return next;
  }

  eventStream.onEvent((evt) => {
    if (evt.type === "ack" || evt.type === "heartbeat") return;
    triggerDashboardBroadcast();
  });

  const unhookCmuxListener = onCmuxConnectionChange((connected) => {
    const payload = JSON.stringify({
      type: "cmux_status",
      connected,
      socketPath: resolveCmuxSocketPath(),
    });
    for (const ws of wsClients) {
      try {
        if (ws.bufferedAmount < 256 * 1024) ws.send(payload);
      } catch {}
    }
    triggerDashboardBroadcast();
  });

  // Self-scheduling, non-overlapping surface poll loop
  let isPolling = false;
  let isRunning = true;
  let pollTimeout: any = null;

  const scheduleNextPoll = () => {
    if (!isRunning) return;
    pollTimeout = setTimeout(async () => {
      if (wsClients.size > 0 && !isPolling) {
        isPolling = true;
        try {
          const watchedMap = new Map<string, { workspaceId: string; surfaceId: string; clients: any[] }>();
          for (const ws of wsClients) {
            const data = ws.data as WsClientData;
            if (data?.watchedWorkspaceId && data?.watchedSurfaceId) {
              const key = `${data.watchedWorkspaceId}:${data.watchedSurfaceId}`;
              if (!watchedMap.has(key)) {
                watchedMap.set(key, {
                  workspaceId: data.watchedWorkspaceId,
                  surfaceId: data.watchedSurfaceId,
                  clients: [],
                });
              }
              watchedMap.get(key)!.clients.push(ws);
            }
          }

          for (const group of watchedMap.values()) {
            try {
              const detail = await getSurfaceDetail(group.workspaceId, group.surfaceId);
              const hash = `${detail.messages.length}:${detail.rawTerminalText.length}:${detail.rawTerminalText.slice(-160)}:${detail.detectedPrompt?.title || ""}`;
              const payload = JSON.stringify({ type: "surface_detail", data: detail });
              for (const ws of group.clients) {
                if (ws.data.lastSurfaceHash !== hash && ws.bufferedAmount < 256 * 1024) {
                  ws.data.lastSurfaceHash = hash;
                  ws.send(payload);
                }
              }
            } catch {
              // ignore
            }
          }
        } finally {
          isPolling = false;
        }
      }
      scheduleNextPoll();
    }, 900);
  };
  scheduleNextPoll();

  const dashboardSyncInterval = setInterval(() => {
    if (wsClients.size > 0) {
      triggerDashboardBroadcast();
    }
  }, 4500);

  const server = Bun.serve<WsClientData>({
    hostname: "0.0.0.0",
    port,
    async fetch(req, srv) {
      // 1. DNS Rebinding Protection: validate Host header
      const host = req.headers.get("host");
      if (!isValidHostHeader(host)) {
        return withSecurityHeaders(
          new Response("Invalid Host header (DNS rebinding rejected)", { status: 400 })
        );
      }

      // 2. Authentication & Authorization for untrusted networks
      const clientIp = srv.requestIP(req)?.address;
      const auth = verifyRequestAuth(req, clientIp);

      const url = new URL(req.url);
      const pathname = url.pathname;

      if (!auth.ok) {
        if (pathname.startsWith("/api/")) {
          return jsonResponse({ ok: false, error: "Unauthorized: Orbit auth token required" }, 401);
        }
        return withSecurityHeaders(
          new Response(renderAuthHtml(), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        );
      }

      // 3. WebSocket upgrade (CSWSH Protection)
      if (pathname === "/ws") {
        const origin = req.headers.get("origin");
        if (origin) {
          try {
            const originHost = new URL(origin).host;
            if (!isValidHostHeader(originHost)) {
              return withSecurityHeaders(new Response("Forbidden WebSocket origin", { status: 403 }));
            }
          } catch {
            return withSecurityHeaders(new Response("Invalid WebSocket origin", { status: 403 }));
          }
        }
        const upgraded = srv.upgrade(req, {
          data: {},
        });
        if (upgraded) return undefined;
        return withSecurityHeaders(new Response("WebSocket upgrade failed", { status: 400 }));
      }

      // REST API Routes
      if (pathname === "/api/health") {
        return jsonResponse({
          ok: true,
          service: "cmux-orbit",
          version: "1.0.0",
          cmuxConnected: isCmuxConnected(),
          socketPath: resolveCmuxSocketPath(),
          timestamp: new Date().toISOString(),
        });
      }

      if (pathname === "/api/dashboard" && req.method === "GET") {
        try {
          const snapshot = await buildDashboardSnapshot();
          return jsonResponse({ ok: true, data: snapshot });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Failed to load dashboard" }, 500);
        }
      }

      if (pathname === "/api/surface" && req.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") || "";
        const surfaceId = url.searchParams.get("surfaceId") || "";
        if (!surfaceId) {
          return jsonResponse({ ok: false, error: "surfaceId is required" }, 400);
        }
        try {
          const detail = await getSurfaceDetail(workspaceId, surfaceId);
          return jsonResponse({ ok: true, data: detail });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Failed to load surface" }, 404);
        }
      }

      if (pathname === "/api/git" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd") || "";
        if (cwd) {
          const safe = isPathSafeAndAllowed(cwd);
          if (!safe.ok) {
            return jsonResponse({ ok: false, error: safe.error || "Git inspection denied" }, 403);
          }
        }
        try {
          const gitInfo = await inspectGitWorkspace(cwd);
          return jsonResponse({ ok: true, data: gitInfo });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Git inspection failed" }, 500);
        }
      }

      if (pathname === "/api/file" && req.method === "GET") {
        const path = url.searchParams.get("path") || "";
        const cwd = url.searchParams.get("cwd") || undefined;
        if (!path) {
          return jsonResponse({ ok: false, error: "path is required" }, 400);
        }
        const preview = readFilePreview(path, cwd);
        return jsonResponse({ ok: preview.ok, data: preview });
      }

      if (pathname === "/api/dirs" && req.method === "GET") {
        const queryPath = url.searchParams.get("path") || join(process.env.HOME || "", "Projects");
        const fullPath = resolveSafeFilePath(queryPath);
        const safe = isPathSafeAndAllowed(fullPath);
        if (!safe.ok) {
          return jsonResponse({ ok: false, error: safe.error || "Directory access denied" }, 403);
        }
        try {
          if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
            const entries = readdirSync(fullPath, { withFileTypes: true })
              .filter((ent) => ent.isDirectory() && !ent.name.startsWith("."))
              .slice(0, 40)
              .map((ent) => formatDirectoryEntry(join(fullPath, ent.name)));
            return jsonResponse({
              ok: true,
              data: {
                currentPath: fullPath,
                parentPath: fullPath === (process.env.HOME || "") ? null : resolve(fullPath, ".."),
                items: entries,
              },
            });
          }
          return jsonResponse({ ok: false, error: "Not a directory" }, 400);
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Failed to list directory" }, 500);
        }
      }

      if (pathname === "/api/vault" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").toLowerCase().trim();
        const agentFilter = (url.searchParams.get("agent") || "").toLowerCase().trim();
        const sessions = await getVaultSessions(true);
        const filtered = sessions
          .filter((s) => {
            if (agentFilter && s.agent.toLowerCase() !== agentFilter) return false;
            if (!q) return true;
            return (
              (s.title || "").toLowerCase().includes(q) ||
              (s.cwd || "").toLowerCase().includes(q) ||
              (s.agent || "").toLowerCase().includes(q) ||
              (s.session_id || "").toLowerCase().includes(q)
            );
          })
          .slice(0, 60);
        return jsonResponse({ ok: true, data: filtered });
      }

      if (pathname === "/api/vault/transcript" && req.method === "GET") {
        const file = url.searchParams.get("file") || "";
        const agent = url.searchParams.get("agent") || undefined;
        if (!file) {
          return jsonResponse({ ok: false, error: "file is required" }, 400);
        }
        const fullFile = resolveSafeFilePath(file);
        const safe = isPathSafeAndAllowed(fullFile);
        if (!safe.ok) {
          return jsonResponse({ ok: false, error: safe.error || "Transcript access denied" }, 403);
        }
        const messages = parseTranscriptFile(fullFile, agent, 80);
        return jsonResponse({ ok: true, data: messages });
      }

      if (pathname === "/api/feed" && req.method === "GET") {
        try {
          const feed = await cmuxRpc<any>("feed.list", {}, 3000);
          return jsonResponse({ ok: true, data: feed?.items || [] });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Failed to fetch feed" }, 500);
        }
      }

      if (pathname === "/api/media" && (req.method === "GET" || req.method === "HEAD")) {
        const rawPath = url.searchParams.get("path") || "";
        if (!rawPath) {
          return jsonResponse({ ok: false, error: "path is required" }, 400);
        }
        const fullPath = resolveSafeFilePath(rawPath);
        const safe = isMediaSafeAndAllowed(fullPath);
        if (!safe.ok) {
          return jsonResponse({ ok: false, error: safe.error || "Media access denied" }, 403);
        }
        if (!existsSync(fullPath)) {
          return jsonResponse({ ok: false, error: "Media file not found" }, 404);
        }

        const lower = fullPath.toLowerCase();
        let contentType = "application/octet-stream";
        if (lower.endsWith(".png")) contentType = "image/png";
        else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (lower.endsWith(".gif")) contentType = "image/gif";
        else if (lower.endsWith(".webp")) contentType = "image/webp";
        else if (lower.endsWith(".svg")) contentType = "image/svg+xml";
        else if (lower.endsWith(".bmp")) contentType = "image/bmp";
        else if (lower.endsWith(".ico")) contentType = "image/x-icon";
        else if (lower.endsWith(".pdf")) contentType = "application/pdf";
        else if (lower.endsWith(".txt") || lower.endsWith(".log")) contentType = "text/plain; charset=utf-8";
        else if (lower.endsWith(".md")) contentType = "text/markdown; charset=utf-8";
        else if (lower.endsWith(".json")) contentType = "application/json; charset=utf-8";

        const bunFile = Bun.file(fullPath);
        const res = new Response(bunFile, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
        return withSecurityHeaders(res);
      }

      if (pathname === "/api/upload" && req.method === "POST") {
        if (!isCsrfSafe(req)) {
          return jsonResponse({ ok: false, error: "Forbidden cross-origin upload request" }, 403);
        }
        try {
          const formData = await req.formData();
          const file = formData.get("file");
          if (!file || typeof file === "string") {
            return jsonResponse({ ok: false, error: "No file uploaded in 'file' field" }, 400);
          }
          const blob = file as File;
          const originalName = blob.name || "upload.png";
          const rawExt = extname(originalName).toLowerCase() || ".png";
          const cleanExt = rawExt.replace(/[^a-z0-9.]/g, "") || ".png";

          const ALLOWED_EXTS = new Set([
            ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".pdf",
            ".txt", ".md", ".json", ".csv", ".log"
          ]);
          if (!ALLOWED_EXTS.has(cleanExt)) {
            return jsonResponse({ ok: false, error: `Disallowed upload file extension: ${cleanExt}` }, 400);
          }

          if (!existsSync(MEDIA_DIR)) {
            mkdirSync(MEDIA_DIR, { recursive: true });
          }

          const filename = `media-${Date.now()}-${randomBytes(4).toString("hex")}${cleanExt}`;
          const targetPath = join(MEDIA_DIR, filename);

          const arrayBuffer = await blob.arrayBuffer();
          await Bun.write(targetPath, arrayBuffer);

          const previewUrl = `/api/media?path=${encodeURIComponent(targetPath)}`;

          return jsonResponse({
            ok: true,
            filePath: targetPath,
            filename: originalName,
            size: blob.size,
            mimeType: blob.type || "application/octet-stream",
            previewUrl,
          });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Upload failed" }, 500);
        }
      }

      // Mutating Actions (Strict CSRF Check & cmux Connected Check)
      if (pathname === "/api/action" && req.method === "POST") {
        if (!isCsrfSafe(req)) {
          return jsonResponse({ ok: false, error: "Forbidden cross-origin action request" }, 403);
        }

        if (!isCmuxConnected()) {
          return jsonResponse(
            {
              ok: false,
              error: "cmux is currently unreachable (cmux app may be closed or restarting). Actions are temporarily paused.",
            },
            503
          );
        }

        try {
          const body = await req.json();
          const action = body.action;

          if (action === "send_prompt") {
            const { workspaceId, surfaceId, text, submit = true } = body;
            if (!workspaceId || !surfaceId || typeof text !== "string") {
              return jsonResponse({ ok: false, error: "workspaceId, surfaceId, and text required" }, 400);
            }
            await enqueueSurfaceAction(surfaceId, async () => {
              await cmuxRpc("surface.focus", { surface_id: surfaceId }).catch(() => null);
              await cmuxRpc("surface.send_text", {
                workspace_id: workspaceId,
                surface_id: surfaceId,
                text,
              });
              if (submit) {
                await new Promise((r) => setTimeout(r, 60));
                await cmuxRpc("surface.send_key", {
                  workspace_id: workspaceId,
                  surface_id: surfaceId,
                  key: "enter",
                });
              }
            });
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "send_key") {
            const { workspaceId, surfaceId, key } = body;
            if (!workspaceId || !surfaceId || !key) {
              return jsonResponse({ ok: false, error: "workspaceId, surfaceId, and key required" }, 400);
            }
            await enqueueSurfaceAction(surfaceId, async () => {
              await cmuxRpc("surface.focus", { surface_id: surfaceId }).catch(() => null);
              await cmuxRpc("surface.send_key", {
                workspace_id: workspaceId,
                surface_id: surfaceId,
                key,
              });
            });
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "resize_terminal" || action === "resize") {
            const { surfaceId, cols, rows } = body;
            if (!surfaceId || !cols || !rows) {
              return jsonResponse({ ok: false, error: "surfaceId, cols, and rows required" }, 400);
            }
            await enqueueSurfaceAction(surfaceId, async () => {
              try {
                await cmuxRpc("terminal.size_policy.set", {
                  surface_id: surfaceId,
                  mode: "fixed",
                  fixed_cols: Number(cols),
                  fixed_rows: Number(rows),
                });
              } catch {
                await cmuxRpc("mobile.terminal.viewport", {
                  surface_id: surfaceId,
                  columns: Number(cols),
                  rows: Number(rows),
                }).catch(() => null);
              }
            });
            return jsonResponse({ ok: true });
          }

          if (action === "answer_prompt") {
            const { workspaceId, surfaceId, key, submit = true } = body;
            if (!workspaceId || !surfaceId || !key) {
              return jsonResponse({ ok: false, error: "workspaceId, surfaceId, and key required" }, 400);
            }
            await enqueueSurfaceAction(surfaceId, async () => {
              await cmuxRpc("surface.focus", { surface_id: surfaceId }).catch(() => null);
              if (key === "escape" || key === "ctrl+c" || key === "enter") {
                await cmuxRpc("surface.send_key", {
                  workspace_id: workspaceId,
                  surface_id: surfaceId,
                  key,
                });
              } else {
                await cmuxRpc("surface.send_text", {
                  workspace_id: workspaceId,
                  surface_id: surfaceId,
                  text: String(key),
                });
                if (submit) {
                  await new Promise((r) => setTimeout(r, 50));
                  await cmuxRpc("surface.send_key", {
                    workspace_id: workspaceId,
                    surface_id: surfaceId,
                    key: "enter",
                  });
                }
              }
            });
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "select_workspace") {
            const { workspaceId } = body;
            await cmuxRpc("workspace.select", { workspace_id: workspaceId });
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "focus_surface") {
            const { surfaceId } = body;
            await cmuxRpc("surface.focus", { surface_id: surfaceId });
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "spawn_workspace") {
            const { cwd, title, command, initialPrompt } = body;
            if (cwd) {
              const safe = isPathSafeAndAllowed(cwd);
              if (!safe.ok) {
                return jsonResponse({ ok: false, error: `Invalid cwd: ${safe.error}` }, 400);
              }
            }
            const params: Record<string, any> = {};
            if (title) params.title = title;
            if (cwd) params.cwd = cwd;
            if (command) params.initial_command = command;

            const created = await cmuxRpc<any>("workspace.create", params, 4000);
            const newWsId = created?.workspace_id || created?.workspace?.id;

            if (initialPrompt && newWsId) {
              setTimeout(async () => {
                try {
                  const sList = await cmuxRpc<any>("surface.list", { workspace_id: newWsId });
                  const firstSurf = sList?.surfaces?.[0]?.id;
                  if (firstSurf) {
                    await cmuxRpc("surface.send_text", {
                      workspace_id: newWsId,
                      surface_id: firstSurf,
                      text: initialPrompt,
                    });
                    await new Promise((r) => setTimeout(r, 80));
                    await cmuxRpc("surface.send_key", {
                      workspace_id: newWsId,
                      surface_id: firstSurf,
                      key: "enter",
                    });
                  }
                } catch {
                  // ignore
                }
              }, 1600);
            }

            triggerDashboardBroadcast();
            return jsonResponse({ ok: true, data: created });
          }

          if (action === "spawn_surface") {
            const { workspaceId, cwd, title, command, initialPrompt } = body;
            if (!workspaceId) {
              return jsonResponse({ ok: false, error: "workspaceId required" }, 400);
            }
            if (cwd) {
              const safe = isPathSafeAndAllowed(cwd);
              if (!safe.ok) {
                return jsonResponse({ ok: false, error: `Invalid cwd: ${safe.error}` }, 400);
              }
            }
            const created = await cmuxRpc<any>(
              "surface.create",
              {
                workspace_id: workspaceId,
                type: "terminal",
                ...(title ? { title } : {}),
              },
              4000
            );
            const newSurfaceId = created?.surface_id || created?.surface?.id || created?.id;
            if (newSurfaceId && (cwd || command)) {
              await new Promise((r) => setTimeout(r, 350));
              const parts: string[] = [];
              if (cwd) parts.push(`cd ${escapeShellArg(cwd)}`);
              if (command) parts.push(command);
              const cmdLine = parts.join(" && ");
              await cmuxRpc("surface.send_text", {
                workspace_id: workspaceId,
                surface_id: newSurfaceId,
                text: cmdLine,
              });
              await new Promise((r) => setTimeout(r, 60));
              await cmuxRpc("surface.send_key", {
                workspace_id: workspaceId,
                surface_id: newSurfaceId,
                key: "enter",
              });

              if (initialPrompt) {
                setTimeout(async () => {
                  try {
                    await cmuxRpc("surface.send_text", {
                      workspace_id: workspaceId,
                      surface_id: newSurfaceId,
                      text: initialPrompt,
                    });
                    await new Promise((r) => setTimeout(r, 80));
                    await cmuxRpc("surface.send_key", {
                      workspace_id: workspaceId,
                      surface_id: newSurfaceId,
                      key: "enter",
                    });
                  } catch {
                    // ignore
                  }
                }, 1600);
              }
            }
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true, data: created });
          }

          return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err?.message || "Action failed" }, 500);
        }
      }

      // Static PWA Asset Serving
      const relPath = pathname === "/" ? "/index.html" : pathname;
      if (relPath.includes("..")) {
        return withSecurityHeaders(new Response("Forbidden", { status: 403 }));
      }
      const filePath = join(PUBLIC_DIR, relPath);
      if (existsSync(filePath)) {
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        const res = new Response(readFileSync(filePath), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": relPath === "/index.html" ? "no-cache" : "public, max-age=3600",
          },
        });
        if (auth.setCookie) {
          res.headers.set("Set-Cookie", auth.setCookie);
        }
        return withSecurityHeaders(res);
      }

      // SPA Fallback
      const indexHtml = join(PUBLIC_DIR, "index.html");
      if (existsSync(indexHtml)) {
        const res = new Response(readFileSync(indexHtml), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
        if (auth.setCookie) {
          res.headers.set("Set-Cookie", auth.setCookie);
        }
        return withSecurityHeaders(res);
      }

      return withSecurityHeaders(new Response("Not Found", { status: 404 }));
    },
    websocket: {
      async open(ws) {
        wsClients.add(ws);
        try {
          ws.send(
            JSON.stringify({
              type: "cmux_status",
              connected: isCmuxConnected(),
              socketPath: resolveCmuxSocketPath(),
            })
          );
          const snapshot = await buildDashboardSnapshot();
          ws.send(JSON.stringify({ type: "dashboard", data: snapshot }));
        } catch {
          // ignore
        }
      },
      async message(ws, message) {
        try {
          const msg = JSON.parse(String(message));
          if (msg.type === "watch" && msg.surfaceId) {
            ws.data.watchedWorkspaceId = msg.workspaceId || "";
            ws.data.watchedSurfaceId = msg.surfaceId;
            ws.data.lastSurfaceHash = "";
            const detail = await getSurfaceDetail(
              ws.data.watchedWorkspaceId || "",
              ws.data.watchedSurfaceId!
            );
            ws.data.lastSurfaceHash = `${detail.messages.length}:${detail.rawTerminalText.length}:${detail.rawTerminalText.slice(-160)}:${detail.detectedPrompt?.title || ""}`;
            ws.send(JSON.stringify({ type: "surface_detail", data: detail }));
          } else if (msg.type === "unwatch") {
            ws.data.watchedWorkspaceId = undefined;
            ws.data.watchedSurfaceId = undefined;
            ws.data.lastSurfaceHash = undefined;
          } else if (msg.type === "refresh") {
            const snapshot = await buildDashboardSnapshot();
            ws.send(JSON.stringify({ type: "dashboard", data: snapshot }));
            if (ws.data.watchedSurfaceId) {
              const detail = await getSurfaceDetail(
                ws.data.watchedWorkspaceId || "",
                ws.data.watchedSurfaceId
              );
              ws.send(JSON.stringify({ type: "surface_detail", data: detail }));
            }
          }
        } catch {
          // ignore
        }
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });

  return {
    server,
    stop() {
      isRunning = false;
      if (pollTimeout) clearTimeout(pollTimeout);
      clearInterval(dashboardSyncInterval);
      unhookCmuxListener();
      eventStream.stop();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 4400);
  const { server } = startOrbitServer(port);
  console.log(`✦ cmux-orbit listening on http://0.0.0.0:${server.port}`);
}
