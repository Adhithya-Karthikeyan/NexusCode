/**
 * `@nexuscode/server` — the public entrypoint for the `nexus serve` REST daemon
 * (system-spec §24). It embeds a `@nexuscode/sdk` Nexus (a client of the single
 * engine the CLI drives) and exposes the harness over HTTP + Server-Sent Events.
 *
 * ```ts
 * import { createNexusServer } from "@nexuscode/server";
 *
 * const server = await createNexusServer({
 *   nexusOptions: { config: { defaultProvider: "mock", defaultModel: "mock-fast" } },
 * });
 * const { port } = await server.listen();
 * console.log(`nexus serving on ${server.url} (token: ${server.authToken})`);
 * // …later
 * await server.close();
 * ```
 */

export { NexusServer, createNexusServer, httpResource } from "./server.js";
export type {
  NexusServerOptions,
  ServerEnterprise,
  ServerPrincipal,
} from "./server.js";

export { RunManager, BadRequestError } from "./runs.js";
export type {
  RunKind,
  RunOpts,
  RunRequest,
  RunState,
  RunRecord,
  SessionRecord,
} from "./runs.js";

export {
  SERVER_TOKEN_REF,
  generateToken,
  resolveAuthToken,
  bearerFrom,
  tokenMatches,
} from "./auth.js";

export { redactConfig, REDACTED } from "./redact.js";
