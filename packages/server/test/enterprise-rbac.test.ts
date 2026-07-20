/**
 * REST daemon enterprise RBAC tests (system-spec §25). With an enterprise seam
 * wired, the daemon maps each bearer token → principal → role and authorizes
 * every data route:
 *   - a viewer principal's token can READ the catalog (200) but is FORBIDDEN
 *     (403) from starting a run;
 *   - a developer principal's token may start a run;
 *   - the master server token keeps full access (admin, RBAC bypassed);
 *   - an unknown token is unauthorized (401);
 *   - with NO enterprise seam, behavior is the single-token baseline (regression).
 * Fully offline over the mock provider.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SecretSource, SecretStore } from "@nexuscode/config";
import { buildEnterpriseServices } from "@nexuscode/enterprise";
import {
  createNexusServer,
  httpResource,
  NexusServer,
  type ServerEnterprise,
} from "../src/index.js";

class MemStore implements SecretStore {
  readonly map = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.map.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.map.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.map.delete(ref);
  }
  async source(ref: string): Promise<SecretSource | null> {
    return this.map.has(ref) ? "file" : null;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Build a ServerEnterprise from the real enterprise services bundle. */
function enterpriseSeam(): { seam: ServerEnterprise; audits: number } {
  const services = buildEnterpriseServices({
    mode: "on",
    principals: [
      { id: "vince", roles: ["viewer"], token: "TOK_VIEWER" },
      { id: "dana", roles: ["developer"], token: "TOK_DEV" },
    ],
  });
  const state = { audits: 0 };
  const seam: ServerEnterprise = {
    principalForToken: (t) => services.principalForToken(t),
    authorize: (p, action, resource) =>
      services.authorize({ id: p.id, roles: p.roles }, action, resource),
    audit: () => {
      state.audits++;
    },
  };
  return { seam, get audits() { return state.audits; } } as { seam: ServerEnterprise; audits: number };
}

async function boot(enterprise?: ServerEnterprise): Promise<{
  server: NexusServer;
  base: string;
  token: string;
}> {
  const server = await createNexusServer({
    secrets: new MemStore(),
    nexusOptions: { config: { defaultProvider: "mock", defaultModel: "mock-fast" } },
    ...(enterprise ? { enterprise } : {}),
  });
  await server.listen();
  cleanups.push(() => server.close());
  return { server, base: server.url, token: server.authToken };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("REST daemon — enterprise RBAC enforcement", () => {
  it("lets a viewer token read the catalog but 403s a run start", async () => {
    const { seam } = enterpriseSeam();
    const { base } = await boot(seam);

    const read = await fetch(`${base}/v1/providers`, { headers: bearer("TOK_VIEWER") });
    expect(read.status).toBe(200);

    const run = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...bearer("TOK_VIEWER"), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(run.status).toBe(403);
    const body = (await run.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("forbidden");
  });

  it("lets a developer token start a run", async () => {
    const { seam } = enterpriseSeam();
    const { base } = await boot(seam);
    const run = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...bearer("TOK_DEV"), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", provider: "mock", model: "mock-fast" }),
    });
    expect(run.status).toBe(202);
  });

  it("keeps the master server token as a full-access admin (RBAC bypassed)", async () => {
    const { seam } = enterpriseSeam();
    const { base, token } = await boot(seam);
    const run = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", provider: "mock", model: "mock-fast" }),
    });
    expect(run.status).toBe(202);
  });

  it("classifies a hypothetical DELETE / unmapped mutating route as write, not read (fail closed by omission)", () => {
    // Every method except the one explicitly-mapped `POST /v1/runs` used to
    // default to "read" — which a viewer/default role is granted. A FUTURE
    // mutating route (PUT/PATCH/DELETE, or any other POST) must fail closed to
    // "write" instead, even though nothing here special-cased its path.
    expect(httpResource("DELETE", "/v1/runs/some-id")).toEqual({
      action: "write",
      resource: "command:runs",
    });
    expect(httpResource("PUT", "/v1/sessions/abc")).toEqual({
      action: "write",
      resource: "command:sessions",
    });
    expect(httpResource("PATCH", "/v1/config")).toEqual({ action: "write", resource: "command:config" });
    // A GET (or the one mapped POST) is unaffected.
    expect(httpResource("GET", "/v1/providers")).toEqual({ action: "read", resource: "command:providers" });
    expect(httpResource("POST", "/v1/runs")).toEqual({ action: "execute", resource: "command:run" });
  });

  it("403s a viewer token on a hypothetical DELETE to an unmapped mutating route", async () => {
    const { seam } = enterpriseSeam();
    const { base } = await boot(seam);
    const res = await fetch(`${base}/v1/runs/some-run-id`, {
      method: "DELETE",
      headers: bearer("TOK_VIEWER"),
    });
    // No DELETE route actually exists (server would 404), but RBAC runs BEFORE
    // route dispatch — a viewer must never reach a mutating route regardless
    // of whether it's implemented yet.
    expect(res.status).toBe(403);
  });

  it("401s an unknown token", async () => {
    const { seam } = enterpriseSeam();
    const { base } = await boot(seam);
    const read = await fetch(`${base}/v1/providers`, { headers: bearer("NOT_A_TOKEN") });
    expect(read.status).toBe(401);
  });

  it("is the single-token baseline when no enterprise seam is wired (regression)", async () => {
    const { base, token } = await boot();
    // Master token works; no principal-token concept exists.
    const ok = await fetch(`${base}/v1/providers`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/v1/providers`, { headers: bearer("TOK_VIEWER") });
    expect(bad.status).toBe(401);
  });
});
