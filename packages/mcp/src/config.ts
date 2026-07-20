/**
 * MCP server declaration (system-spec §7). A NexusCode config declares zero or
 * more MCP servers; each is reached over one of three transports:
 *
 *   stdio — spawn a local `command` with `args`/`env` and speak MCP on its pipes.
 *   sse   — connect to a remote Server-Sent-Events endpoint `url`.
 *   http  — connect to a remote Streamable-HTTP endpoint `url`.
 *
 * Auth material is NEVER inlined here. A remote transport declares logical
 * references (`bearerRef`, `headerRefs`) that the client resolves through the
 * `@nexuscode/config` `SecretStore` at connect time — the plaintext token only
 * ever lives in memory, never in the config cascade or the trace store.
 */

import { z } from "zod";

/** How to reach an MCP server. */
export const McpTransportKind = z.enum(["stdio", "sse", "http"]);
export type McpTransportKind = z.infer<typeof McpTransportKind>;

/**
 * Auth for a remote (sse/http) MCP server. `bearerRef` resolves to a token sent
 * as `Authorization: Bearer <token>`. `headerRefs` maps an arbitrary header
 * name to a secret ref (e.g. `{ "X-Api-Key": "acme-mcp" }`). Both are logical
 * refs into the SecretStore; a `headers` map of already-known plaintext values
 * may also be supplied for non-secret headers.
 */
export const McpAuthConfig = z
  .object({
    /** SecretStore ref → `Authorization: Bearer <resolved>`. */
    bearerRef: z.string().min(1).optional(),
    /** Header name → SecretStore ref (resolved and attached per request). */
    headerRefs: z.record(z.string(), z.string()).default({}),
    /** Static, non-secret headers merged into every request. */
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type McpAuthConfigInput = z.input<typeof McpAuthConfig>;
export type McpAuthConfig = z.infer<typeof McpAuthConfig>;

export const McpServerConfig = z
  .object({
    /** Stable, unique server id, e.g. "github". Also the tool-name namespace. */
    name: z.string().min(1),
    /** Transport family. */
    transport: McpTransportKind,
    /** Disable without deleting the declaration. */
    enabled: z.boolean().default(true),
    /**
     * Trust this server's tool annotations (`readOnlyHint`) enough to let them
     * auto-downgrade a tool's permission classification to `"read"`. MCP
     * annotations are advisory/self-declared by the SERVER (untrusted per the
     * MCP spec) — default false so a remote or spawned server cannot label a
     * destructive/exfiltrating tool `readOnlyHint: true` and have it auto-run
     * with no approval. Only set true for servers you actually trust.
     */
    trustAnnotations: z.boolean().default(false),

    // ── stdio ──────────────────────────────────────────────────────────────
    /** stdio: executable to spawn (e.g. "npx"). */
    command: z.string().optional(),
    /** stdio: argv for `command`. */
    args: z.array(z.string()).default([]),
    /** stdio: extra env for the child (merged over a safe inherited base). */
    env: z.record(z.string(), z.string()).default({}),

    // ── sse / http ─────────────────────────────────────────────────────────
    /** sse/http: endpoint URL. */
    url: z.string().url().optional(),
    /** sse/http: auth material (resolved via SecretStore). */
    auth: McpAuthConfig.optional(),

    /** Per-request timeout override (ms). */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio") {
      if (!cfg.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `mcp server "${cfg.name}": stdio transport requires "command"`,
          path: ["command"],
        });
      }
    } else if (!cfg.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mcp server "${cfg.name}": ${cfg.transport} transport requires "url"`,
        path: ["url"],
      });
    }
  });
export type McpServerConfigInput = z.input<typeof McpServerConfig>;
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Parse/validate one server declaration (throws `ZodError` on bad shape). */
export function parseMcpServerConfig(input: unknown): McpServerConfig {
  return McpServerConfig.parse(input);
}
