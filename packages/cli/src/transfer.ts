/**
 * Production ZLCTS bootstrap for CLI surfaces.
 *
 * The core owns only a structural TransferHandleFactory. This module binds that
 * seam to the configured SQLite sidecar, one shared mutex, and an encrypted
 * content-addressed blob store. Every command receives the same behavior;
 * provider packages remain completely unaware of transfer persistence.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  ProviderActionGuard,
  ProviderHandoffBuilder,
  TransferHandleFactory,
} from "@nexuscode/core";
import type { NexusConfig, SecretStore } from "@nexuscode/config";
import {
  createBlobStore,
  createMutex,
  createTransferHandle,
  createHandoffCapsule,
  deserializeHandoffCapsule,
  migrateMindDb,
  recoverUnfolded,
  renderHandoffCapsuleMessage,
  type DbLike,
} from "@nexuscode/transfer";

const TRANSFER_KEY_REF = "nexus.transfer.encryption-key.v1";

/** Isolate encrypted stores per database; legacy session stores use their parent. */
function encryptedBlobDir(dbPath: string): string {
  return `${dbPath}.zlcts`;
}

interface TransferDb extends DbLike {
  close(): void;
}

export interface TransferRuntime {
  /** Undefined when transfer is disabled or could not be initialized safely. */
  factory?: TransferHandleFactory;
  /** Build a signed, bounded provider-neutral capsule at a failover boundary. */
  handoffBuilder?: ProviderHandoffBuilder;
  /** Enforce reconstructed do-not-repeat actions before tool execution. */
  actionGuard?: ProviderActionGuard;
  /** Human-readable status suitable for doctor/audit output; contains no secret. */
  detail: string;
  close(): void;
}

const DISABLED: TransferRuntime = {
  detail: "disabled",
  close() {
    /* no-op */
  },
};

function messageText(message: Parameters<ProviderHandoffBuilder>[0]["messages"][number]): string {
  return message.content
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "tool_use") {
        return `[tool ${block.name} id=${block.id}] ${JSON.stringify(block.input)}`;
      }
      if (block.type === "tool_result") return `[tool result ${block.toolCallId}]`;
      if (block.type === "image") return `[image ${block.mime}]`;
      if (block.type === "audio") return `[audio ${block.mime}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

interface ReconstructedEvent {
  actionId: string;
  action: string;
  target?: string;
  result: "success" | "failure" | "partial" | "in-progress" | "unknown";
  title: string;
  body: string;
  files: string[];
  lamportTs: number;
}

interface ReconstructedItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
}

interface GuardWindow {
  remainingTurns: number;
  lastTurnId?: string;
  blockedFingerprints: Set<string>;
  blockedActionIds: Set<string>;
  workspaceRoot: string;
  expectedWorkspaceFingerprint?: string;
  workspaceValidated: boolean;
}

function canonicalValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalValue((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function actionFingerprint(name: string, input: unknown): string {
  return createHash("sha256")
    .update(`${name}\u0000${JSON.stringify(canonicalValue(input))}`)
    .digest("hex");
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function reconstructEvents(db: TransferDb, sessionId: string): ReconstructedEvent[] {
  const rows = db
    .prepare(
      `SELECT w.action_id, w.lamport_ts, i.title, i.body, i.fields_json
         FROM zlcts_wal w
         LEFT JOIN zlcts_items i ON i.id = w.entity_id
        WHERE w.session_id = ? AND w.op_type = 'execution-event'
        ORDER BY w.lamport_ts DESC LIMIT 256`,
    )
    .all(sessionId) as Array<{
      action_id: string;
      lamport_ts: number;
      title: string | null;
      body: string | null;
      fields_json: string | null;
    }>;
  return rows
    .map((row) => {
      const fields = safeJson<Record<string, unknown>>(row.fields_json, {});
      const result =
        fields["result"] === "success" ||
        fields["result"] === "failure" ||
        fields["result"] === "partial" ||
        fields["result"] === "in-progress"
          ? fields["result"]
          : "unknown";
      const event: ReconstructedEvent = {
        actionId: row.action_id,
        action: typeof fields["action"] === "string" ? fields["action"] : "unknown",
        result,
        title: row.title ?? "Execution event",
        body: row.body ?? "",
        files: Array.isArray(fields["deltaFiles"])
          ? fields["deltaFiles"].filter((entry): entry is string => typeof entry === "string")
          : [],
        lamportTs: Number(row.lamport_ts),
      };
      if (typeof fields["target"] === "string") event.target = fields["target"];
      return event;
    })
    .reverse();
}

function reconstructItems(db: TransferDb): ReconstructedItem[] {
  return db
    .prepare(
      `SELECT id, kind, title, body, status
         FROM zlcts_items
        WHERE status = 'active'
          AND kind IN ('task','todo','work-done','decision','assumption','constraint','open-question','failure')
        ORDER BY importance DESC, updated_at DESC LIMIT 128`,
    )
    .all() as ReconstructedItem[];
}

function reconstructToolInputs(
  db: TransferDb,
  blobs: ReturnType<typeof createBlobStore>,
  sessionId: string,
): Map<string, { name: string; input: unknown; fingerprint: string }> {
  const rows = db
    .prepare(
      `SELECT payload_ref FROM zlcts_verbatim
        WHERE session_id = ? AND chunk_type = 'tool-call-end'
        ORDER BY lamport_ts DESC LIMIT 256`,
    )
    .all(sessionId) as Array<{ payload_ref: string }>;
  const out = new Map<string, { name: string; input: unknown; fingerprint: string }>();
  const names = new Map<string, string>();
  const starts = db
    .prepare(
      `SELECT payload_ref FROM zlcts_verbatim
        WHERE session_id = ? AND chunk_type = 'tool-call-start'
        ORDER BY lamport_ts DESC LIMIT 256`,
    )
    .all(sessionId) as Array<{ payload_ref: string }>;
  for (const row of starts) {
    const bytes = blobs.get(row.payload_ref);
    if (!bytes) continue;
    const chunk = safeJson<Record<string, unknown>>(Buffer.from(bytes).toString("utf8"), {});
    if (typeof chunk["id"] === "string" && typeof chunk["name"] === "string") {
      names.set(chunk["id"], chunk["name"]);
    }
  }
  for (const row of rows) {
    const bytes = blobs.get(row.payload_ref);
    if (!bytes) continue;
    const chunk = safeJson<Record<string, unknown>>(Buffer.from(bytes).toString("utf8"), {});
    const id = typeof chunk["id"] === "string" ? chunk["id"] : undefined;
    if (!id) continue;
    const name = names.get(id) ?? "tool";
    const input = chunk["input"];
    out.set(id, { name, input, fingerprint: actionFingerprint(name, input) });
  }
  return out;
}

function gitWorkspace(root: string): {
  modifiedFiles: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed" | "untracked";
    summary?: string;
  }>;
  fingerprint?: string;
} {
  try {
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const modifiedFiles = status
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(0, 512)
      .map((line) => {
        const code = line.slice(0, 2);
        const rawPath = line.slice(3);
        const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
        const state: "added" | "modified" | "deleted" | "renamed" | "untracked" =
          code === "??"
            ? "untracked"
            : code.includes("R")
              ? "renamed"
              : code.includes("D")
                ? "deleted"
                : code.includes("A")
                  ? "added"
                  : "modified";
        return { path, status: state, summary: `git status ${code.trim() || code}` };
      });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const fingerprint = createHash("sha256")
      .update(`${head}\n${status}`)
      .digest("hex");
    return { modifiedFiles, fingerprint };
  } catch {
    return { modifiedFiles: [] };
  }
}

function makeHandoffBuilder(
  config: NexusConfig,
  db: TransferDb,
  blobs: ReturnType<typeof createBlobStore>,
  integrityKey: Uint8Array,
  guardWindows: Map<string, GuardWindow>,
  workspaceRoot: string,
): ProviderHandoffBuilder {
  return (input) => {
    const events = reconstructEvents(db, input.sessionId);
    const items = reconstructItems(db);
    const toolInputs = reconstructToolInputs(db, blobs, input.sessionId);
    const workspace = gitWorkspace(workspaceRoot);
    const userMessages = input.messages.filter((message) => message.role === "user");
    const objective =
      messageText(userMessages.at(-1) ?? input.messages.at(-1) ?? { role: "user", content: [] }).trim() ||
      "Continue the current Nexus project task.";
    const contextManifest = input.messages.map((message, index) => ({
      id: `message-${String(index).padStart(4, "0")}`,
      kind: `conversation-${message.role}`,
      source: message.name ?? "nexus-session",
      inclusion: "included" as const,
      reason: "assembled by the Nexus context engine and preserved for the replacement provider",
      content: messageText(message),
    }));
    if (input.system) {
      contextManifest.unshift({
        id: "system-instructions",
        kind: "system",
        source: "nexus-context",
        inclusion: "included",
        reason: "active provider-neutral system instructions",
        content: input.system,
      });
    }
    if (workspace.fingerprint) {
      contextManifest.unshift({
        id: "workspace-fingerprint",
        kind: "workspace-fingerprint",
        source: workspaceRoot,
        inclusion: "included",
        reason: "used by the post-switch validation gate to detect workspace drift",
        content: workspace.fingerprint,
      });
    }
    const capsule = createHandoffCapsule(
      {
        source: {
          sessionId: input.sessionId,
          runId: `${input.turnId}:handoff:${input.attempt}`,
          turn: input.attempt,
          providerId: input.fromProviderId,
          modelId: input.fromModelId,
        },
        target: {
          providerId: input.toProviderId,
          modelId: input.toModelId,
        },
        goal: {
          objective,
          currentGoal: objective,
          successCriteria: [
            "Continue the existing project without losing prior decisions or context.",
            "Do not repeat completed or partially applied actions.",
          ],
        },
        plan: items
          .filter((item) => item.kind === "task" || item.kind === "todo" || item.kind === "work-done")
          .map((item) => ({
            id: item.id,
            title: item.title,
            status:
              item.kind === "work-done"
                ? ("completed" as const)
                : item.status === "active"
                  ? ("pending" as const)
                  : ("blocked" as const),
            details: item.body,
            blockers: [],
            relatedFiles: [],
          })),
        decisions: [
          ...items
            .filter((item) => item.kind === "decision")
            .map((item) => ({
              id: item.id,
              decision: item.title,
              rationale: item.body,
              alternatives: [],
            })),
          {
            id: `failover-${input.attempt}`,
            decision: `Transfer execution from ${input.fromProviderId} to ${input.toProviderId}.`,
            rationale: `${input.error.code}: ${input.error.message}`,
            alternatives: ["Retry only after the blocked provider becomes healthy."],
          },
        ],
        assumptions: items
          .filter((item) => item.kind === "assumption")
          .map((item) => ({ id: item.id, statement: item.title, riskIfWrong: item.body })),
        constraints: [
          {
            id: "provider-neutral-state",
            kind: "must",
            statement: "Treat this as the same Nexus project and session, not a new project.",
            source: "system",
          },
          {
            id: "no-private-state",
            kind: "must-not",
            statement: "Do not invent vendor-private hidden state that Nexus cannot transfer.",
            source: "system",
          },
          ...items
            .filter((item) => item.kind === "constraint")
            .map((item) => ({
              id: item.id,
              kind: "must" as const,
              statement: `${item.title}: ${item.body}`,
              source: "project" as const,
            })),
        ],
        unresolvedQuestions: items
          .filter((item) => item.kind === "open-question")
          .map((item) => ({ id: item.id, question: `${item.title}: ${item.body}`, blocker: true })),
        workspace: {
          modifiedFiles: workspace.modifiedFiles,
          commands: events
            .filter((event) => /(?:shell|bash|terminal|command|exec)/iu.test(event.action))
            .map((event) => ({
              id: event.target ?? event.actionId,
              command: event.title,
              status:
                event.result === "success"
                  ? ("success" as const)
                  : event.result === "failure"
                    ? ("failure" as const)
                    : event.result === "in-progress"
                      ? ("in-progress" as const)
                      : ("partial" as const),
              summary: event.body,
            })),
          tests: events
            .filter((event) => /test|vitest|jest|pytest|cargo test/iu.test(`${event.action} ${event.title}`))
            .map((event) => ({
              id: event.target ?? event.actionId,
              command: event.title,
              status:
                event.result === "success"
                  ? ("passed" as const)
                  : event.result === "failure"
                    ? ("failed" as const)
                    : ("partial" as const),
              summary: event.body,
            })),
        },
        tools: {
          outcomes: events
            .filter(
              (event) =>
                !event.action.startsWith("turn-") &&
                event.action !== "run-end" &&
                event.action !== "error",
            )
            .map((event) => {
              const id = event.target ?? event.actionId;
              const tool = toolInputs.get(id);
              return {
                actionId: tool?.fingerprint ?? id,
                tool: tool?.name ?? event.action,
                status:
                  event.result === "success"
                    ? ("success" as const)
                    : event.result === "failure"
                      ? ("failure" as const)
                      : event.result === "in-progress"
                        ? ("in-progress" as const)
                        : ("partial" as const),
                summary: event.body,
                ...(event.result === "partial" || event.result === "in-progress"
                  ? { partialEffect: event.body }
                  : {}),
                idempotent: false,
                turn: Math.max(0, input.attempt),
              };
            }),
          pendingApprovals: events
            .filter((event) => event.action === "approval" && event.result === "in-progress")
            .map((event) => ({
              actionId: event.target ?? event.actionId,
              description: event.body,
              requestedBy: input.fromProviderId,
            })),
        },
        contextManifest,
        doNotRepeatActionIds: [
          ...new Set(
            events
              .filter(
                (event) =>
                  event.result === "success" ||
                  event.result === "partial" ||
                  event.result === "in-progress",
              )
              .map((event) => {
                const id = event.target ?? event.actionId;
                return toolInputs.get(id)?.fingerprint ?? id;
              }),
          ),
        ],
      },
      {
        config: config.transfer,
        maxTokens: config.transfer.handoff.maxCapsuleTokens,
        maxBytes: config.transfer.handoff.maxCapsuleBytes,
        integrityKey,
      },
    );
    const blockedFingerprints = new Set(capsule.doNotRepeatActionIds);
    const blockedActionIds = new Set(
      events
        .filter(
          (event) =>
            event.result === "success" ||
            event.result === "partial" ||
            event.result === "in-progress",
        )
        .map((event) => event.target ?? event.actionId),
    );
    guardWindows.set(input.sessionId, {
      remainingTurns: capsule.handoff.preventRetryWindow,
      blockedFingerprints,
      blockedActionIds,
      workspaceRoot,
      ...(workspace.fingerprint
        ? { expectedWorkspaceFingerprint: workspace.fingerprint }
        : {}),
      workspaceValidated: false,
    });
    const serialized = JSON.stringify(capsule);
    const manifestRef = blobs.put(serialized);
    db.prepare(
      `INSERT OR REPLACE INTO zlcts_handoffs
        (id, session_id, from_provider, to_provider, reason, manifest_ref, checksum,
         created_at, state, handoff_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      capsule.integrity.hash,
      input.sessionId,
      input.fromProviderId,
      input.toProviderId,
      `${input.error.code}: ${input.error.message}`,
      manifestRef,
      capsule.integrity.hash,
      Date.parse(capsule.createdAt),
      "ready",
      capsule.handoff.mode,
    );
    return renderHandoffCapsuleMessage(capsule, {
      maxTokens: config.transfer.handoff.maxCapsuleTokens,
      maxBytes: config.transfer.handoff.maxCapsuleBytes,
      integrityKey,
    });
  };
}

function decodeKey(value: string | null): Uint8Array | null {
  if (!value) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.byteLength === 32 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

/**
 * Last-resort private key file for headless machines without an unlocked OS
 * keychain or NEXUS_VAULT_PASSPHRASE. It is mode 0600 and atomically created.
 * The SecretStore remains preferred because it separates the key from the db.
 */
function loadOrCreatePrivateKeyFile(dbPath: string): Uint8Array {
  const dir = encryptedBlobDir(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, ".encryption-key");
  if (existsSync(file)) {
    const key = decodeKey(readFileSync(file, "utf8").trim());
    if (!key) throw new Error(`invalid transfer encryption key at ${file}`);
    return key;
  }

  const key = randomBytes(32);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, key.toString("base64"), { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return new Uint8Array(key);
}

async function loadOrCreateEncryptionKey(
  secrets: SecretStore,
  dbPath: string,
): Promise<{ key: Uint8Array; source: "secret-store" | "private-file" }> {
  try {
    const stored = decodeKey(await secrets.get(TRANSFER_KEY_REF));
    if (stored) return { key: stored, source: "secret-store" };
    const key = randomBytes(32);
    await secrets.set(TRANSFER_KEY_REF, key.toString("base64"));
    return { key: new Uint8Array(key), source: "secret-store" };
  } catch {
    return { key: loadOrCreatePrivateKeyFile(dbPath), source: "private-file" };
  }
}

function liveHandoffRows(
  db: TransferDb,
): Array<{ sessionId: string; manifestRef: string }> {
  try {
    return (
      db
        .prepare(
          `SELECT session_id, manifest_ref
             FROM zlcts_handoffs
            WHERE state = 'ready'
            ORDER BY created_at DESC
            LIMIT 256`,
        )
        .all() as Array<{ session_id: string; manifest_ref: string }>
    ).map((row) => ({
      sessionId: row.session_id,
      manifestRef: row.manifest_ref,
    }));
  } catch {
    return [];
  }
}

/**
 * Open the configured transfer runtime. Failure is deliberately non-fatal, but
 * it never falls back to plaintext capture: initialization either returns an
 * encrypted factory or a disabled runtime.
 */
export async function openTransferRuntime(
  config: NexusConfig,
  secrets: SecretStore,
  defaultDbPath: string,
): Promise<TransferRuntime> {
  if (!config.transfer.enabled) return DISABLED;
  // Respect an explicit "no persistence" history mode unless the user supplied
  // a dedicated transfer db. Otherwise a supposedly stateless invocation would
  // still create durable provider transcripts behind their back.
  if (!config.history.enabled && config.transfer.dbPath === undefined) {
    return {
      detail: "disabled because history is off and transfer.dbPath is unset",
      close() {
        /* no-op */
      },
    };
  }
  const dbPath = config.transfer.dbPath ?? defaultDbPath;

  let db: TransferDb | undefined;
  try {
    const { default: Database } = (await import("better-sqlite3")) as unknown as {
      default: new (path: string) => TransferDb;
    };
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    migrateMindDb(db);

    const { key, source } = await loadOrCreateEncryptionKey(secrets, dbPath);
    const blobs = createBlobStore(encryptedBlobDir(dbPath), { encryptionKey: key });
    const mutex = createMutex();
    const guardWindows = new Map<string, GuardWindow>();
    const persistedHandoffs = liveHandoffRows(db);
    for (const row of persistedHandoffs) {
      if (guardWindows.has(row.sessionId)) continue;
      const bytes = blobs.get(row.manifestRef);
      if (!bytes) continue;
      try {
        const capsule = deserializeHandoffCapsule(
          Buffer.from(bytes).toString("utf8"),
          {
            validationStrictness: config.transfer.validationStrictness,
            maxTokens: config.transfer.handoff.maxCapsuleTokens,
            maxBytes: config.transfer.handoff.maxCapsuleBytes,
            integrityKey: key,
          },
        );
        const expectedWorkspaceFingerprint = capsule.contextManifest.find(
          (entry) => entry.id === "workspace-fingerprint",
        )?.content;
        guardWindows.set(row.sessionId, {
          remainingTurns: capsule.handoff.preventRetryWindow,
          blockedFingerprints: new Set(capsule.doNotRepeatActionIds),
          blockedActionIds: new Set(capsule.tools.outcomes.map((outcome) => outcome.actionId)),
          workspaceRoot: process.cwd(),
          ...(expectedWorkspaceFingerprint
            ? { expectedWorkspaceFingerprint }
            : {}),
          workspaceValidated: false,
        });
      } catch {
        // Invalid/tampered capsules never become executable guard state.
      }
    }
    const actionGuard: ProviderActionGuard = (input) => {
      const window = guardWindows.get(input.sessionId);
      if (!window || input.permission === "read") return { blocked: false };
      if (window.lastTurnId !== input.turnId) {
        if (window.lastTurnId !== undefined) window.remainingTurns -= 1;
        window.lastTurnId = input.turnId;
      }
      if (window.remainingTurns <= 0) {
        guardWindows.delete(input.sessionId);
        return { blocked: false };
      }
      if (!window.workspaceValidated && window.expectedWorkspaceFingerprint) {
        const current = gitWorkspace(window.workspaceRoot).fingerprint;
        if (!current || current !== window.expectedWorkspaceFingerprint) {
          return {
            blocked: true,
            reason:
              "workspace changed after the provider handoff; refresh context before applying mutations",
          };
        }
        window.workspaceValidated = true;
      }
      const fingerprint = actionFingerprint(input.name, input.input);
      if (
        window.blockedActionIds.has(input.actionId) ||
        window.blockedFingerprints.has(fingerprint)
      ) {
        return {
          blocked: true,
          reason:
            `matches a completed, partial, or in-flight pre-switch action ` +
            `(${window.remainingTurns} protected turn(s) remain)`,
        };
      }
      return { blocked: false };
    };

    // Replay append-before-fold rows using the same encrypted blob store and
    // mutex the live handles use. This is safe and idempotent.
    recoverUnfolded(db, blobs, mutex);

    const liveDb = db;
    const sessionClocks = new Map<string, number>();
    const nextLamportFor = (sessionId: string): number => {
      let current = sessionClocks.get(sessionId);
      if (current === undefined) {
        const row = liveDb
          .prepare("SELECT COALESCE(MAX(lamport_ts), 0) AS value FROM zlcts_wal WHERE session_id=?")
          .get(sessionId) as { value: number };
        current = Number(row.value);
      }
      const next = current + 1;
      sessionClocks.set(sessionId, next);
      return next;
    };
    const factory: TransferHandleFactory = ({ sessionId, turnId, runId }) =>
      createTransferHandle({
        db: liveDb,
        blobs,
        mutex,
        sessionId,
        turnId,
        runId,
        nextLamport: () => nextLamportFor(sessionId),
      });

    return {
      factory,
      handoffBuilder: makeHandoffBuilder(
        config,
        liveDb,
        blobs,
        key,
        guardWindows,
        process.cwd(),
      ),
      actionGuard,
      detail: `enabled · encrypted · key=${source} · db=${dbPath}`,
      close() {
        try {
          liveDb.close();
        } catch {
          /* already closed */
        }
      },
    };
  } catch (e) {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return {
      detail: `unavailable: ${e instanceof Error ? e.message : String(e)}`,
      close() {
        /* no-op */
      },
    };
  }
}
