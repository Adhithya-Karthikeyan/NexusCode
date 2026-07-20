/**
 * `nexus serve` — start the REST daemon (`@nexuscode/server`, system-spec §24).
 *
 * The daemon embeds ONE `@nexuscode/sdk` Nexus (itself a client of the single
 * engine the CLI drives) and exposes the harness over HTTP + SSE. This command
 * is a thin launcher: it builds the server through the shared runtime bootstrap
 * (loading on-disk config so configured providers are available), binds it to
 * loopback by default, prints the URL + bearer token, and stays up until SIGINT.
 *
 * Security posture is enforced by the server: bearer-token auth on every data
 * route, loopback bind by default, redacted `GET /v1/config`, PermissionGate on
 * agent/tool execution. The token is printed once on startup so a first-party
 * client can authenticate — it is the operator's own token on their own machine.
 */

import { createSecretStore, loadConfig } from "@nexuscode/config";
import { createNexusServer } from "@nexuscode/server";
import type { ParsedArgs } from "./args.js";
import type { Io } from "./commands.js";
import { buildEnterprise, toServerEnterprise } from "./enterprise.js";
import { userConfigDir } from "./config-io.js";

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Parse a `--port` / `--host` value; invalid port falls back to ephemeral (0). */
function parsePort(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 65535 ? n : 0;
}

export async function cmdServe(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const host = args.flags.get("host") ?? "127.0.0.1";
  const port = parsePort(args.flags.get("port"));

  const secrets = createSecretStore();
  // Enterprise RBAC (§25): when mode=on, map each bearer token → principal →
  // role and authorize every data request (403 on deny). Off ⇒ single-token
  // behavior is unchanged.
  const { config } = await loadConfig({ userConfigDir: userConfigDir() });
  const enterprise = await buildEnterprise(config, secrets);

  let server;
  try {
    server = await createNexusServer({
      host,
      port,
      secrets,
      nexusOptions: { loadFromDisk: true, cwd: process.cwd() },
      ...(enterprise.enabled ? { enterprise: toServerEnterprise(enterprise) } : {}),
      version: "0.0.0",
    });
  } catch (e) {
    io.err(`nexus serve: failed to build server — ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  try {
    await server.listen();
  } catch (e) {
    io.err(`nexus serve: failed to bind ${host}:${port} — ${e instanceof Error ? e.message : String(e)}\n`);
    await server.close();
    return 1;
  }

  const url = server.url;
  const token = server.authToken;
  io.out(`NexusCode server listening on ${url}\n`);
  io.out(`health:  ${url}/v1/health  (public, no auth)\n`);
  io.out(`\nEvery other route requires a bearer token. Your token (loopback-only):\n`);
  io.out(`  ${token}\n`);
  io.out(`\nExample:\n`);
  io.out(`  curl -H "Authorization: Bearer ${token}" ${url}/v1/providers\n`);
  io.out(`\nPress Ctrl+C to stop.\n`);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      io.err("\nnexus serve: shutting down…\n");
      void server.close().then(() => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve(0);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
