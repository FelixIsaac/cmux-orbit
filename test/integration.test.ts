import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startOrbitServer } from "../src/server/index";

describe("cmux-orbit live integration tests", () => {
  let instance: ReturnType<typeof startOrbitServer>;
  let baseUrl = "";

  beforeAll(() => {
    instance = startOrbitServer(0); // random available port
    baseUrl = `http://127.0.0.1:${instance.server.port}`;
  });

  afterAll(() => {
    instance.stop();
  });

  test("GET /api/health returns ok and resolved cmux socket path", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("cmux-orbit");
    expect(body.socketPath).toContain("cmux.sock");
  });

  test("GET /api/dashboard returns live workspaces and surfaces from cmux.sock", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.totalWorkspaces).toBeGreaterThan(0);
    expect(body.data.totalSurfaces).toBeGreaterThan(0);
    expect(Array.isArray(body.data.workspaces)).toBe(true);
  });

  test("GET /api/surface loads structured agent detail and terminal buffer for a live surface", async () => {
    const dashRes = await fetch(`${baseUrl}/api/dashboard`);
    const dash = (await dashRes.json()).data;
    const firstWs = dash.workspaces[0];
    const firstSurf = firstWs.surfaces[0];

    const surfRes = await fetch(
      `${baseUrl}/api/surface?workspaceId=${encodeURIComponent(firstWs.id)}&surfaceId=${encodeURIComponent(firstSurf.id)}`
    );
    expect(surfRes.status).toBe(200);
    const surfBody = await surfRes.json();
    expect(surfBody.ok).toBe(true);
    expect(surfBody.data.surface.id).toBe(firstSurf.id);
    expect(["agent", "markdown", "terminal"]).toContain(surfBody.data.modeDefault);
  });

  test("GET /api/vault returns multi-agent session history", async () => {
    const res = await fetch(`${baseUrl}/api/vault`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });
});
