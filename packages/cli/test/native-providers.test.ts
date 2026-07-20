/**
 * In-process, offline tests for the native cloud-model provider catalog
 * (gemini / bedrock / vertex). `buildRuntime` is driven directly with a stub
 * SecretStore and a credential-free env (HOME pointed at an empty temp dir so no
 * ~/.aws or gcloud ADC files are found) so the "needs key/creds" path is
 * deterministic. No network is ever touched: registration is offline (static
 * capabilities, health probe skipped).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { buildRuntime } from "../src/runtime.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

const CRED_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
];

let saved: Record<string, string | undefined> = {};
let emptyHome: string;

beforeAll(() => {
  emptyHome = mkdtempSync(join(tmpdir(), "nx-home-"));
  saved = {};
  for (const k of [...CRED_ENV_KEYS, "HOME", "USERPROFILE", "APPDATA"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = emptyHome;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(emptyHome, { recursive: true, force: true });
});

describe("native provider catalog — offline registration", () => {
  it("registers gemini, bedrock, and vertex and reports needs-key/creds (no crash)", async () => {
    const config = NexusConfig.parse({});
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    try {
      const byId = new Map(runtime.statuses.map((s) => [s.id, s]));

      for (const id of ["gemini", "bedrock", "vertex"]) {
        const s = byId.get(id);
        expect(s, `${id} should be in the catalog`).toBeDefined();
        expect(s!.available, `${id} registers available`).toBe(true);
        expect(s!.needsKey, `${id} needs a credential in a clean env`).toBe(true);
        expect(runtime.registry.has(id)).toBe(true);
      }

      expect(byId.get("gemini")!.kind).toBe("gemini");
      expect(byId.get("bedrock")!.kind).toBe("bedrock");
      expect(byId.get("vertex")!.kind).toBe("vertex");
      expect(byId.get("gemini")!.detail).toMatch(/needs key/);
      expect(byId.get("bedrock")!.detail).toMatch(/needs creds/);
      expect(byId.get("vertex")!.detail).toMatch(/needs creds/);
    } finally {
      await runtime.registry.disposeAll();
    }
  });

  it("reports static capabilities without any network call", async () => {
    const config = NexusConfig.parse({});
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    try {
      const gemini = runtime.registry.capabilitiesOf("gemini");
      expect(gemini.streaming).toBe(true);
      expect(gemini.vision).toBe(true);
      const bedrock = runtime.registry.capabilitiesOf("bedrock");
      expect(bedrock.streaming).toBe(true);
      const vertex = runtime.registry.capabilitiesOf("vertex");
      expect(vertex.tools).toBe(true);
      // Model aliases from config are resolvable through the registry.
      expect(runtime.registry.resolveModel("gemini-flash")?.providerId).toBe("gemini");
      expect(runtime.registry.resolveModel("bedrock-sonnet")?.providerId).toBe("bedrock");
    } finally {
      await runtime.registry.disposeAll();
    }
  });

  it("marks gemini key-present when the env var is set", async () => {
    process.env.GEMINI_API_KEY = "test-key-value";
    try {
      const config = NexusConfig.parse({});
      const runtime = await buildRuntime(config, { secrets: stubSecrets });
      try {
        const s = runtime.statuses.find((x) => x.id === "gemini");
        expect(s?.needsKey).toBe(false);
        expect(s?.detail).toMatch(/key present/);
      } finally {
        await runtime.registry.disposeAll();
      }
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("drops a provider from the catalog when disabled in config", async () => {
    const config = NexusConfig.parse({ bedrock: { enabled: false } });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    try {
      expect(runtime.registry.has("bedrock")).toBe(false);
      expect(runtime.statuses.find((s) => s.id === "bedrock")).toBeUndefined();
      // gemini/vertex remain.
      expect(runtime.registry.has("gemini")).toBe(true);
      expect(runtime.registry.has("vertex")).toBe(true);
    } finally {
      await runtime.registry.disposeAll();
    }
  });
});
