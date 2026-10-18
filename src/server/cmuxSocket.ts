import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CmuxRpcResponse<T = any> {
  id: string;
  ok: boolean;
  result?: T;
  error?: {
    code: string;
    message: string;
    data?: any;
  };
}

export interface CmuxStreamEvent {
  protocol: string;
  version: number;
  type?: string;
  id?: number;
  ts?: string;
  category?: string;
  name?: string;
  workspace_id?: string;
  surface_id?: string;
  payload?: any;
}

export function resolveCmuxSocketPath(): string {
  const envPath = process.env.CMUX_SOCKET_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const home = homedir();
  const pointerFiles = [
    join(home, ".local/state/cmux/last-socket-path"),
    join(home, "Library/Application Support/cmux/last-socket-path"),
    "/tmp/cmux-last-socket-path",
  ];

  for (const ptr of pointerFiles) {
    try {
      if (existsSync(ptr)) {
        const target = readFileSync(ptr, "utf8").trim();
        if (target && existsSync(target)) return target;
      }
    } catch {
      // ignore
    }
  }

  const defaultSock = join(home, ".local/state/cmux/cmux.sock");
  return defaultSock;
}

let reqCounter = 0;

/**
 * Executes a single JSON-RPC call over a fresh Unix domain socket connection to cmux.sock.
 * Opening a per-request short-lived connection or pooled connection avoids per-connection token-bucket exhaustion.
 */
export async function cmuxRpc<T = any>(
  method: string,
  params: Record<string, any> = {},
  timeoutMs = 3500
): Promise<T> {
  const socketPath = resolveCmuxSocketPath();
  const reqId = `orbit-${++reqCounter}-${Date.now()}`;
  const payload = JSON.stringify({ id: reqId, method, params }) + "\n";

  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`cmux RPC timeout (${timeoutMs}ms) for method: ${method}`));
      }
    }, timeoutMs);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          buffer += Buffer.from(chunk).toString("utf8");
          const nlIndex = buffer.indexOf("\n");
          if (nlIndex !== -1 && !settled) {
            settled = true;
            clearTimeout(timer);
            const line = buffer.slice(0, nlIndex).trim();
            socket.end();
            try {
              const parsed = JSON.parse(line) as CmuxRpcResponse<T>;
              if (parsed.ok) {
                resolve(parsed.result as T);
              } else {
                reject(
                  new Error(
                    `cmux RPC error [${parsed.error?.code || "unknown"}] on ${method}: ${
                      parsed.error?.message || "Failed"
                    }`
                  )
                );
              }
            } catch (err) {
              reject(err);
            }
          }
        },
        error(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
        close() {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`cmux socket closed before response for ${method}`));
          }
        },
      },
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Persistent subscriber to cmux `events.stream` across all categories.
 * Automatically reconnects if cmux restarts.
 */
export class CmuxEventStream {
  private listeners = new Set<(evt: CmuxStreamEvent) => void>();
  private running = false;
  private activeSocket: any = null;
  private reconnectTimer: any = null;

  start() {
    if (this.running) return;
    this.running = true;
    this.connectLoop();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.activeSocket) {
      try {
        this.activeSocket.end();
      } catch {
        // ignore
      }
    }
  }

  onEvent(cb: (evt: CmuxStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(evt: CmuxStreamEvent) {
    for (const cb of this.listeners) {
      try {
        cb(evt);
      } catch {
        // ignore listener error
      }
    }
  }

  private connectLoop() {
    if (!this.running) return;
    const socketPath = resolveCmuxSocketPath();
    let buffer = "";

    Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          this.activeSocket = socket;
          const subReq =
            JSON.stringify({
              id: "orbit-stream",
              method: "events.stream",
              params: {
                categories: ["workspace", "surface", "notification", "system", "agent", "hook"],
              },
            }) + "\n";
          socket.write(subReq);
        },
        data: (_socket, chunk) => {
          buffer += Buffer.from(chunk).toString("utf8");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.protocol === "cmux-events") {
                this.emit(parsed as CmuxStreamEvent);
              }
            } catch {
              // ignore malformed frame
            }
          }
        },
        error: () => {
          this.scheduleReconnect();
        },
        close: () => {
          this.scheduleReconnect();
        },
      },
    }).catch(() => {
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connectLoop(), 2000);
  }
}
