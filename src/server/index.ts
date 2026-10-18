import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cmuxRpc, CmuxEventStream, resolveCmuxSocketPath } from "./cmuxSocket";
import {
  buildDashboardSnapshot,
  getSurfaceDetail,
  getVaultSessions,
} from "./stateAggregator";
import { parseTranscriptFile } from "./transcriptEngine";
import { inspectGitWorkspace, readFilePreview } from "./workspaceInspector";

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

/**
 * Verifies that the client IP is loopback, Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48), or private LAN.
 */
function isTrustedPeerAddress(ip?: string | null): boolean {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
  // Tailscale IPv4 100.64.0.0/10 (100.64.x.x - 100.127.x.x)
  const parts = clean.split(".").map((n) => parseInt(n, 10));
  if (parts.length === 4 && !parts.some(isNaN)) {
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  if (clean.startsWith("fd7a:115c:a1e0:") || clean.startsWith("fe80:")) return true;
  return false;
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function startOrbitServer(port = Number(process.env.PORT || 4400)) {
  const wsClients = new Set<any>();
  const eventStream = new CmuxEventStream();
  eventStream.start();

  let broadcastDebounce: any = null;
  const triggerDashboardBroadcast = () => {
    if (broadcastDebounce) return;
    broadcastDebounce = setTimeout(async () => {
      broadcastDebounce = null;
      if (wsClients.size === 0) return;
      try {
        const snapshot = await buildDashboardSnapshot();
        const payload = JSON.stringify({ type: "dashboard", data: snapshot });
        for (const ws of wsClients) {
          try {
            ws.send(payload);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }, 350);
  };

  eventStream.onEvent((evt) => {
    if (evt.type === "ack" || evt.type === "heartbeat") return;
    triggerDashboardBroadcast();
  });

  // Periodic watched-surface live refresh + dashboard sync
  const pollInterval = setInterval(async () => {
    if (wsClients.size === 0) return;
    for (const ws of wsClients) {
      const data = ws.data as WsClientData;
      if (data?.watchedWorkspaceId && data?.watchedSurfaceId) {
        try {
          const detail = await getSurfaceDetail(
            data.watchedWorkspaceId,
            data.watchedSurfaceId
          );
          const hash = `${detail.messages.length}:${detail.rawTerminalText.length}:${detail.rawTerminalText.slice(-160)}:${detail.detectedPrompt?.title || ""}`;
          if (hash !== data.lastSurfaceHash) {
            data.lastSurfaceHash = hash;
            ws.send(JSON.stringify({ type: "surface_detail", data: detail }));
          }
        } catch {
          // ignore
        }
      }
    }
  }, 900);

  const dashboardSyncInterval = setInterval(() => {
    if (wsClients.size > 0) {
      triggerDashboardBroadcast();
    }
  }, 4500);

  const server = Bun.serve<WsClientData>({
    hostname: "0.0.0.0",
    port,
    async fetch(req, srv) {
      const clientIp = srv.requestIP(req)?.address;
      if (!isTrustedPeerAddress(clientIp)) {
        return jsonResponse({ ok: false, error: "Forbidden peer network" }, 403);
      }

      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade
      if (pathname === "/ws") {
        const upgraded = srv.upgrade(req, {
          data: {},
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // REST API Routes
      if (pathname === "/api/health") {
        return jsonResponse({
          ok: true,
          service: "cmux-orbit",
          version: "1.0.0",
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
        const messages = parseTranscriptFile(file, agent, 80);
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

      if (pathname === "/api/action" && req.method === "POST") {
        try {
          const body = await req.json();
          const action = body.action;

          if (action === "send_prompt") {
            const { workspaceId, surfaceId, text, submit = true } = body;
            if (!workspaceId || !surfaceId || typeof text !== "string") {
              return jsonResponse({ ok: false, error: "workspaceId, surfaceId, and text required" }, 400);
            }
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
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "send_key") {
            const { workspaceId, surfaceId, key } = body;
            if (!workspaceId || !surfaceId || !key) {
              return jsonResponse({ ok: false, error: "workspaceId, surfaceId, and key required" }, 400);
            }
            await cmuxRpc("surface.focus", { surface_id: surfaceId }).catch(() => null);
            await cmuxRpc("surface.send_key", {
              workspace_id: workspaceId,
              surface_id: surfaceId,
              key,
            });
            triggerDashboardBroadcast();
            return jsonResponse({ ok: true });
          }

          if (action === "answer_prompt") {
            const { workspaceId, surfaceId, key, submit = true } = body;
            if (!workspaceId || !surfaceId || !key) {
              return jsonResponse({ ok: false, error: "workspaceId, surfaceId, and key required" }, 400);
            }
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
              if (cwd) parts.push(`cd ${JSON.stringify(cwd)}`);
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
        return new Response("Forbidden", { status: 403 });
      }
      const filePath = join(PUBLIC_DIR, relPath);
      if (existsSync(filePath)) {
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        return new Response(readFileSync(filePath), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "no-cache",
          },
        });
      }

      // SPA Fallback
      const indexHtml = join(PUBLIC_DIR, "index.html");
      if (existsSync(indexHtml)) {
        return new Response(readFileSync(indexHtml), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      async open(ws) {
        wsClients.add(ws);
        try {
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
      clearInterval(pollInterval);
      clearInterval(dashboardSyncInterval);
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
