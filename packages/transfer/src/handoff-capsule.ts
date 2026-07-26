/**
 * Provider-neutral handoff capsule.
 *
 * A capsule is the explicit, portable state a replacement provider receives.
 * It contains only harness-owned state: no vendor conversation ids, hidden
 * reasoning, credentials, or provider-specific message objects. Capsules are
 * redacted before they are signed, canonically serialized, and bounded before
 * they can leave this package.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ContextTransferConfig } from "@nexuscode/config";
import type { Message } from "@nexuscode/shared";

export const HANDOFF_CAPSULE_SCHEMA = "nexus.handoff-capsule/v1" as const;

export type HandoffMode = "full" | "consult";
export type CapsuleValidationStrictness = "strict" | "relaxed";
export type CapsuleCompressionPolicy = "semantic" | "truncateMiddle";
export type WorkStatus = "pending" | "in-progress" | "completed" | "blocked" | "cancelled";
export type OutcomeStatus = "pending" | "in-progress" | "success" | "partial" | "failure";

export interface CapsuleGoal {
  objective: string;
  currentGoal: string;
  successCriteria: string[];
}

export interface CapsuleTask {
  id: string;
  title: string;
  status: WorkStatus;
  details?: string;
  blockers: string[];
  relatedFiles: string[];
}

export interface CapsuleDecision {
  id: string;
  decision: string;
  rationale: string;
  alternatives: string[];
}

export interface CapsuleAssumption {
  id: string;
  statement: string;
  riskIfWrong?: string;
}

export interface CapsuleConstraint {
  id: string;
  kind: "must" | "should" | "must-not";
  statement: string;
  source: "user" | "system" | "project" | "inferred";
}

export interface CapsuleQuestion {
  id: string;
  question: string;
  blocker: boolean;
}

export interface CapsuleModifiedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  summary?: string;
  diff?: string;
}

export interface CapsuleCommand {
  id: string;
  command: string;
  status: OutcomeStatus;
  cwd?: string;
  exitCode?: number;
  summary?: string;
  output?: string;
}

export interface CapsuleTestRun {
  id: string;
  command: string;
  status: "passed" | "failed" | "partial" | "not-run";
  summary: string;
  output?: string;
}

export interface CapsuleToolOutcome {
  actionId: string;
  tool: string;
  status: OutcomeStatus;
  summary: string;
  output?: string;
  partialEffect?: string;
  idempotent: boolean;
  turn: number;
}

export interface CapsulePendingApproval {
  actionId: string;
  description: string;
  requestedBy: string;
}

export interface CapsuleContextEntry {
  id: string;
  kind: string;
  source: string;
  inclusion: "included" | "dropped";
  reason: string;
  tokens?: number;
  content?: string;
}

export interface CapsuleCheckpoint {
  id: string;
  offset: number;
  summary: string;
  completedActionIds: string[];
}

export interface CapsulePartialResponse {
  text: string;
  finishReason?: string;
  continuationHint?: string;
  checkpoints: CapsuleCheckpoint[];
}

export interface HandoffCapsulePayload {
  source: {
    sessionId: string;
    runId: string;
    turn: number;
    providerId: string;
    modelId?: string;
  };
  target: {
    providerId: string;
    modelId?: string;
  };
  goal: CapsuleGoal;
  plan: CapsuleTask[];
  decisions: CapsuleDecision[];
  assumptions: CapsuleAssumption[];
  constraints: CapsuleConstraint[];
  unresolvedQuestions: CapsuleQuestion[];
  workspace: {
    modifiedFiles: CapsuleModifiedFile[];
    commands: CapsuleCommand[];
    tests: CapsuleTestRun[];
  };
  tools: {
    outcomes: CapsuleToolOutcome[];
    pendingApprovals: CapsulePendingApproval[];
  };
  contextManifest: CapsuleContextEntry[];
  partialResponse?: CapsulePartialResponse;
  doNotRepeatActionIds: string[];
}

export interface HandoffCapsule extends HandoffCapsulePayload {
  schema: typeof HANDOFF_CAPSULE_SCHEMA;
  createdAt: string;
  handoff: {
    mode: HandoffMode;
    preventRetryWindow: number;
    canExecuteActions: boolean;
  };
  compression: {
    policy: CapsuleCompressionPolicy;
    compressed: boolean;
    omissions: string[];
  };
  integrity: {
    algorithm: "sha256" | "hmac-sha256";
    hash: string;
  };
}

export type HandoffCapsuleInput = HandoffCapsulePayload;

type TransferCapsuleConfig = Pick<
  ContextTransferConfig,
  "compressionPolicy" | "validationStrictness" | "handoff"
>;

export interface HandoffCapsuleOptions {
  config?: TransferCapsuleConfig;
  compressionPolicy?: CapsuleCompressionPolicy;
  validationStrictness?: CapsuleValidationStrictness;
  mode?: HandoffMode;
  preventRetryWindow?: number;
  /** Hard serialized UTF-8 limit. The builder throws if essential state cannot fit. */
  maxBytes?: number;
  /** Hard estimated-token limit. Defaults to `ceil(chars / 4)`. */
  maxTokens?: number;
  estimateTokens?: (text: string) => number;
  /** Values to replace everywhere before signing. Values shorter than 6 chars are ignored. */
  secrets?: Iterable<string>;
  /** Additional application redactor, run after built-in secret scanning. */
  redact?: (text: string) => string;
  /**
   * When supplied, authenticate the capsule with HMAC-SHA256. Omitting it keeps
   * the legacy corruption-only SHA-256 digest for embedders without a key.
   */
  integrityKey?: Uint8Array | string;
  /** Injectable for deterministic tests and replay. */
  createdAt?: string;
}

export interface CapsuleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ActionRetryDecision {
  blocked: boolean;
  reason?: "explicit-do-not-repeat" | "completed-action" | "partial-effect" | "in-flight";
  remainingTurns?: number;
}

export interface RenderHandoffCapsuleOptions {
  /** Role defaults to system so adapters hoist it without creating adjacent user turns. */
  role?: "system" | "user";
  /** Hard limit for the rendered UTF-8 block, including provider instructions. */
  maxBytes?: number;
  /** Hard limit for the rendered block's estimated tokens. */
  maxTokens?: number;
  estimateTokens?: (text: string) => number;
  /** Required when rendering an HMAC-authenticated capsule. */
  integrityKey?: Uint8Array | string;
}

export class HandoffCapsuleValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid handoff capsule: ${issues.join("; ")}`);
    this.name = "HandoffCapsuleValidationError";
    this.issues = issues;
  }
}

export class HandoffCapsuleIntegrityError extends Error {
  constructor() {
    super("handoff capsule integrity check failed");
    this.name = "HandoffCapsuleIntegrityError";
  }
}

export class HandoffCapsuleBudgetError extends Error {
  readonly bytes: number;
  readonly tokens: number;

  constructor(bytes: number, tokens: number) {
    super(`handoff capsule exceeds budget after safe compression (${bytes} bytes, ${tokens} tokens)`);
    this.name = "HandoffCapsuleBudgetError";
    this.bytes = bytes;
    this.tokens = tokens;
  }
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_TOKENS = 48_000;
const DEFAULT_PREVENT_RETRY_WINDOW = 5;
const REDACTED = "<redacted>";

/** Build, redact, canonicalize, compress, validate, and sign a handoff capsule. */
export function createHandoffCapsule(
  input: HandoffCapsuleInput,
  options: HandoffCapsuleOptions = {},
): HandoffCapsule {
  const resolved = resolveOptions(options);
  const inputIssues = validateInput(input);
  if (resolved.validationStrictness === "strict" && inputIssues.length > 0) {
    throw new HandoffCapsuleValidationError(inputIssues);
  }

  const redactor = createRedactor(options);
  const payload = normalizePayload(input, redactor);
  let unsigned: Omit<HandoffCapsule, "integrity"> = {
    schema: HANDOFF_CAPSULE_SCHEMA,
    createdAt: normalizeCreatedAt(options.createdAt, resolved.validationStrictness),
    handoff: {
      mode: resolved.mode,
      preventRetryWindow: resolved.preventRetryWindow,
      canExecuteActions: resolved.mode === "full",
    },
    compression: {
      policy: resolved.compressionPolicy,
      compressed: false,
      omissions: [],
    },
    ...payload,
  };

  let capsule = signCapsule(unsigned, options.integrityKey);
  if (!fitsBudget(capsule, resolved)) {
    unsigned = compressCapsule(unsigned, resolved.compressionPolicy, "large");
    capsule = signCapsule(unsigned, options.integrityKey);
  }
  if (!fitsBudget(capsule, resolved)) {
    unsigned = compressCapsule(unsigned, resolved.compressionPolicy, "small");
    capsule = signCapsule(unsigned, options.integrityKey);
  }
  if (!fitsBudget(capsule, resolved)) {
    const serialized = canonicalStringify(capsule);
    throw new HandoffCapsuleBudgetError(
      Buffer.byteLength(serialized, "utf8"),
      resolved.estimateTokens(serialized),
    );
  }

  const result = validateHandoffCapsule(capsule, {
    validationStrictness: resolved.validationStrictness,
  });
  if (!result.valid) throw new HandoffCapsuleValidationError(result.errors);
  return capsule;
}

/** Canonical JSON; identical logical capsules always produce identical bytes. */
export function serializeHandoffCapsule(
  capsule: HandoffCapsule,
  options: Pick<HandoffCapsuleOptions, "integrityKey"> = {},
): string {
  const validation = validateHandoffCapsule(capsule);
  if (!validation.valid) throw new HandoffCapsuleValidationError(validation.errors);
  verifyHandoffCapsuleIntegrity(capsule, options.integrityKey);
  return canonicalStringify(capsule);
}

/**
 * Render a bounded, provider-neutral instruction block.
 *
 * The JSON remains canonical and integrity-verifiable. The wrapper tells a new
 * provider how to treat full versus consult handoffs without relying on any
 * vendor-specific system-message extensions.
 */
export function renderHandoffCapsuleText(
  capsule: HandoffCapsule,
  options: RenderHandoffCapsuleOptions = {},
): string {
  const serialized = serializeHandoffCapsule(capsule, {
    ...(options.integrityKey !== undefined ? { integrityKey: options.integrityKey } : {}),
  });
  const executionRule =
    capsule.handoff.mode === "consult"
      ? "CONSULT ONLY: advise on the project, but do not execute tools, approvals, or pending actions."
      : "FULL HANDOFF: continue the current goal. Do not repeat action ids blocked by the capsule.";
  const text = [
    "[NEXUS PROVIDER HANDOFF — HARNESS-OWNED CONTEXT]",
    "Treat this capsule as the authoritative continuation state for the existing project, not a new project.",
    executionRule,
    "Preserve constraints, unresolved work, partial effects, and context-drop reasons. Never infer vendor-private state.",
    serialized,
    "[END NEXUS PROVIDER HANDOFF]",
  ].join("\n");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  const bytes = Buffer.byteLength(text, "utf8");
  const tokens = estimateTokens(text);
  if (bytes > maxBytes || tokens > maxTokens) {
    throw new HandoffCapsuleBudgetError(bytes, tokens);
  }
  return text;
}

/** Render the capsule as one normalized Message ready for a provider request. */
export function renderHandoffCapsuleMessage(
  capsule: HandoffCapsule,
  options: RenderHandoffCapsuleOptions = {},
): Message {
  return {
    role: options.role ?? "system",
    name: "nexus-provider-handoff",
    content: [{ type: "text", text: renderHandoffCapsuleText(capsule, options) }],
  };
}

/** Parse an untrusted capsule, validate its schema, and verify its integrity hash. */
export function deserializeHandoffCapsule(
  serialized: string,
  options: Pick<
    HandoffCapsuleOptions,
    "validationStrictness" | "maxBytes" | "maxTokens" | "estimateTokens" | "integrityKey"
  > = {},
): HandoffCapsule {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  const bytes = Buffer.byteLength(serialized, "utf8");
  const tokens = estimateTokens(serialized);
  if (bytes > maxBytes || tokens > maxTokens) {
    throw new HandoffCapsuleBudgetError(bytes, tokens);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new HandoffCapsuleValidationError(["capsule is not valid JSON"]);
  }
  const result = validateHandoffCapsule(parsed, options);
  if (!result.valid) throw new HandoffCapsuleValidationError(result.errors);
  const capsule = parsed as HandoffCapsule;
  verifyHandoffCapsuleIntegrity(capsule, options.integrityKey);
  return capsule;
}

/** Runtime validation for capsules received from storage, IPC, or another host. */
export function validateHandoffCapsule(
  value: unknown,
  options: Pick<HandoffCapsuleOptions, "validationStrictness"> = {},
): CapsuleValidationResult {
  const strictness = options.validationStrictness ?? "strict";
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["capsule must be an object"], warnings };
  }

  requiredString(value, "schema", errors);
  if (value.schema !== HANDOFF_CAPSULE_SCHEMA) errors.push(`unsupported schema: ${String(value.schema)}`);
  requiredString(value, "createdAt", errors);
  if (typeof value.createdAt === "string" && !Number.isFinite(Date.parse(value.createdAt))) {
    errors.push("createdAt must be an ISO timestamp");
  }
  validateHandoff(value.handoff, errors);
  validateCompression(value.compression, errors);
  validateEndpoint(value.source, "source", errors, true);
  validateEndpoint(value.target, "target", errors, false);
  validateGoal(value.goal, errors);

  for (const key of [
    "plan",
    "decisions",
    "assumptions",
    "constraints",
    "unresolvedQuestions",
    "contextManifest",
    "doNotRepeatActionIds",
  ]) {
    if (!Array.isArray(value[key])) errors.push(`${key} must be an array`);
  }
  validateEntityArray(value.plan, "plan", "id", ["title"], errors);
  validateEntityArray(value.decisions, "decisions", "id", ["decision", "rationale"], errors);
  validateEntityArray(value.assumptions, "assumptions", "id", ["statement"], errors);
  validateEntityArray(value.constraints, "constraints", "id", ["statement"], errors);
  validateEntityArray(
    value.unresolvedQuestions,
    "unresolvedQuestions",
    "id",
    ["question"],
    errors,
  );
  validateEntityArray(
    value.contextManifest,
    "contextManifest",
    "id",
    ["kind", "source", "reason"],
    errors,
  );
  validateStringArray(value.doNotRepeatActionIds, "doNotRepeatActionIds", errors);
  if (!isRecord(value.workspace)) errors.push("workspace must be an object");
  else {
    for (const key of ["modifiedFiles", "commands", "tests"]) {
      if (!Array.isArray(value.workspace[key])) errors.push(`workspace.${key} must be an array`);
    }
    validateEntityArray(
      value.workspace.modifiedFiles,
      "workspace.modifiedFiles",
      "path",
      [],
      errors,
    );
    validateEntityArray(
      value.workspace.commands,
      "workspace.commands",
      "id",
      ["command"],
      errors,
    );
    validateEntityArray(
      value.workspace.tests,
      "workspace.tests",
      "id",
      ["command", "summary"],
      errors,
    );
  }
  if (!isRecord(value.tools)) errors.push("tools must be an object");
  else {
    if (!Array.isArray(value.tools.outcomes)) errors.push("tools.outcomes must be an array");
    if (!Array.isArray(value.tools.pendingApprovals)) {
      errors.push("tools.pendingApprovals must be an array");
    }
    validateEntityArray(
      value.tools.outcomes,
      "tools.outcomes",
      "actionId",
      ["tool", "summary"],
      errors,
    );
    validateEntityArray(
      value.tools.pendingApprovals,
      "tools.pendingApprovals",
      "actionId",
      ["description", "requestedBy"],
      errors,
    );
  }
  if (value.partialResponse !== undefined && !isRecord(value.partialResponse)) {
    errors.push("partialResponse must be an object");
  } else if (isRecord(value.partialResponse)) {
    requiredStringAllowEmpty(value.partialResponse, "text", errors, "partialResponse");
    if (!Array.isArray(value.partialResponse.checkpoints)) {
      errors.push("partialResponse.checkpoints must be an array");
    }
    validateEntityArray(
      value.partialResponse.checkpoints,
      "partialResponse.checkpoints",
      "id",
      ["summary"],
      errors,
    );
  }
  if (!isRecord(value.integrity)) errors.push("integrity must be an object");
  else {
    if (
      value.integrity.algorithm !== "sha256" &&
      value.integrity.algorithm !== "hmac-sha256"
    ) {
      errors.push("integrity.algorithm must be sha256 or hmac-sha256");
    }
    if (
      typeof value.integrity.hash !== "string" ||
      !/^(?:sha256|hmac-sha256):[a-f0-9]{64}$/u.test(value.integrity.hash)
    ) {
      errors.push("integrity.hash must be a sha256 or hmac-sha256 digest");
    }
  }

  collectDuplicateIds(value, errors);
  if (strictness === "strict") {
    collectUnknownRootKeys(value, errors);
  } else if (Object.keys(value).some((key) => !ROOT_KEYS.has(key))) {
    warnings.push("unknown root fields were ignored by relaxed validation");
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Throws when a capsule was edited or corrupted after it was signed. */
export function verifyHandoffCapsuleIntegrity(
  capsule: HandoffCapsule,
  integrityKey?: Uint8Array | string,
): void {
  const { integrity: _integrity, ...unsigned } = capsule;
  const expected =
    capsule.integrity.algorithm === "hmac-sha256"
      ? authenticatedIntegrityHash(unsigned, requireIntegrityKey(integrityKey))
      : integrityHash(unsigned);
  const actualBytes = Buffer.from(capsule.integrity.hash, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (
    actualBytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new HandoffCapsuleIntegrityError();
  }
}

/**
 * Prevent duplicate effects immediately after a switch.
 *
 * Explicit do-not-repeat ids are permanent. Completed, partial, and in-flight
 * tool actions are blocked only for the configured post-switch turn window.
 */
export function actionRetryDecision(
  capsule: HandoffCapsule,
  actionId: string,
  turnsSinceHandoff: number,
): ActionRetryDecision {
  if (capsule.doNotRepeatActionIds.includes(actionId)) {
    return { blocked: true, reason: "explicit-do-not-repeat" };
  }
  const outcome = capsule.tools.outcomes.find((entry) => entry.actionId === actionId);
  const remainingTurns = Math.max(0, capsule.handoff.preventRetryWindow - turnsSinceHandoff);
  if (!outcome || remainingTurns === 0 || turnsSinceHandoff < 0) return { blocked: false };
  if (outcome.status === "success") {
    return { blocked: true, reason: "completed-action", remainingTurns };
  }
  if (outcome.status === "partial") {
    return { blocked: true, reason: "partial-effect", remainingTurns };
  }
  if (outcome.status === "in-progress") {
    return { blocked: true, reason: "in-flight", remainingTurns };
  }
  return { blocked: false };
}

/** Public canonicalizer for durable cache keys and byte-for-byte comparisons. */
export function canonicalizeHandoffValue(value: unknown): string {
  return canonicalStringify(value);
}

interface ResolvedOptions {
  compressionPolicy: CapsuleCompressionPolicy;
  validationStrictness: CapsuleValidationStrictness;
  mode: HandoffMode;
  preventRetryWindow: number;
  maxBytes: number;
  maxTokens: number;
  estimateTokens: (text: string) => number;
}

function resolveOptions(options: HandoffCapsuleOptions): ResolvedOptions {
  const config = options.config;
  const preventRetryWindow =
    options.preventRetryWindow ?? config?.handoff.preventRetryWindow ?? DEFAULT_PREVENT_RETRY_WINDOW;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  for (const [name, value] of [
    ["preventRetryWindow", preventRetryWindow],
    ["maxBytes", maxBytes],
    ["maxTokens", maxTokens],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HandoffCapsuleValidationError([`${name} must be a positive integer`]);
    }
  }
  return {
    compressionPolicy: options.compressionPolicy ?? config?.compressionPolicy ?? "semantic",
    validationStrictness: options.validationStrictness ?? config?.validationStrictness ?? "strict",
    mode: options.mode ?? config?.handoff.mode ?? "full",
    preventRetryWindow,
    maxBytes,
    maxTokens,
    estimateTokens: options.estimateTokens ?? defaultEstimateTokens,
  };
}

function normalizePayload(
  input: HandoffCapsuleInput,
  redact: (text: string) => string,
): HandoffCapsulePayload {
  const safe = (value: unknown): string => redact(typeof value === "string" ? value : "");
  const stringList = (value: unknown): string[] =>
    uniqueSorted((Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string").map(safe));
  const array = <T>(value: unknown, map: (entry: Record<string, unknown>) => T): T[] =>
    (Array.isArray(value) ? value : []).filter(isRecord).map(map);
  const opt = (value: unknown): { value?: string } => {
    const text = safe(value);
    return text ? { value: text } : {};
  };

  const source: Record<string, unknown> = isRecord(input.source) ? input.source : {};
  const target: Record<string, unknown> = isRecord(input.target) ? input.target : {};
  const goal: Record<string, unknown> = isRecord(input.goal) ? input.goal : {};
  const workspace: Record<string, unknown> = isRecord(input.workspace) ? input.workspace : {};
  const tools: Record<string, unknown> = isRecord(input.tools) ? input.tools : {};
  const partial = isRecord(input.partialResponse) ? input.partialResponse : undefined;

  const payload: HandoffCapsulePayload = {
    source: {
      sessionId: safe(source.sessionId),
      runId: safe(source.runId),
      turn: safeInteger(source.turn),
      providerId: safe(source.providerId),
      ...(opt(source.modelId).value ? { modelId: opt(source.modelId).value } : {}),
    },
    target: {
      providerId: safe(target.providerId),
      ...(opt(target.modelId).value ? { modelId: opt(target.modelId).value } : {}),
    },
    goal: {
      objective: safe(goal.objective),
      currentGoal: safe(goal.currentGoal),
      successCriteria: stringList(goal.successCriteria),
    },
    plan: sortById(
      array(input.plan, (entry) => ({
        id: safe(entry.id),
        title: safe(entry.title),
        status: workStatus(entry.status),
        ...(opt(entry.details).value ? { details: opt(entry.details).value } : {}),
        blockers: stringList(entry.blockers),
        relatedFiles: stringList(entry.relatedFiles),
      })),
    ),
    decisions: sortById(
      array(input.decisions, (entry) => ({
        id: safe(entry.id),
        decision: safe(entry.decision),
        rationale: safe(entry.rationale),
        alternatives: stringList(entry.alternatives),
      })),
    ),
    assumptions: sortById(
      array(input.assumptions, (entry) => ({
        id: safe(entry.id),
        statement: safe(entry.statement),
        ...(opt(entry.riskIfWrong).value ? { riskIfWrong: opt(entry.riskIfWrong).value } : {}),
      })),
    ),
    constraints: sortById(
      array(input.constraints, (entry) => ({
        id: safe(entry.id),
        kind: constraintKind(entry.kind),
        statement: safe(entry.statement),
        source: constraintSource(entry.source),
      })),
    ),
    unresolvedQuestions: sortById(
      array(input.unresolvedQuestions, (entry) => ({
        id: safe(entry.id),
        question: safe(entry.question),
        blocker: entry.blocker === true,
      })),
    ),
    workspace: {
      modifiedFiles: array(workspace.modifiedFiles, (entry) => ({
        path: safe(entry.path),
        status: fileStatus(entry.status),
        ...(opt(entry.summary).value ? { summary: opt(entry.summary).value } : {}),
        ...(opt(entry.diff).value ? { diff: opt(entry.diff).value } : {}),
      })).sort((a, b) => compare(a.path, b.path)),
      commands: sortById(
        array(workspace.commands, (entry) => ({
          id: safe(entry.id),
          command: safe(entry.command),
          status: outcomeStatus(entry.status),
          ...(opt(entry.cwd).value ? { cwd: opt(entry.cwd).value } : {}),
          ...(typeof entry.exitCode === "number" && Number.isInteger(entry.exitCode)
            ? { exitCode: entry.exitCode }
            : {}),
          ...(opt(entry.summary).value ? { summary: opt(entry.summary).value } : {}),
          ...(opt(entry.output).value ? { output: opt(entry.output).value } : {}),
        })),
      ),
      tests: sortById(
        array(workspace.tests, (entry) => ({
          id: safe(entry.id),
          command: safe(entry.command),
          status: testStatus(entry.status),
          summary: safe(entry.summary),
          ...(opt(entry.output).value ? { output: opt(entry.output).value } : {}),
        })),
      ),
    },
    tools: {
      outcomes: array(tools.outcomes, (entry) => ({
        actionId: safe(entry.actionId),
        tool: safe(entry.tool),
        status: outcomeStatus(entry.status),
        summary: safe(entry.summary),
        ...(opt(entry.output).value ? { output: opt(entry.output).value } : {}),
        ...(opt(entry.partialEffect).value ? { partialEffect: opt(entry.partialEffect).value } : {}),
        idempotent: entry.idempotent === true,
        turn: safeInteger(entry.turn),
      })).sort((a, b) => compare(a.actionId, b.actionId)),
      pendingApprovals: array(tools.pendingApprovals, (entry) => ({
        actionId: safe(entry.actionId),
        description: safe(entry.description),
        requestedBy: safe(entry.requestedBy),
      })).sort((a, b) => compare(a.actionId, b.actionId)),
    },
    contextManifest: array(input.contextManifest, (entry) => ({
      id: safe(entry.id),
      kind: safe(entry.kind),
      source: safe(entry.source),
      inclusion: entry.inclusion === "included" ? ("included" as const) : ("dropped" as const),
      reason: safe(entry.reason),
      ...(typeof entry.tokens === "number" && Number.isFinite(entry.tokens)
        ? { tokens: Math.max(0, Math.ceil(entry.tokens)) }
        : {}),
      ...(opt(entry.content).value ? { content: opt(entry.content).value } : {}),
    })).sort((a, b) => compare(`${a.inclusion}:${a.id}`, `${b.inclusion}:${b.id}`)),
    doNotRepeatActionIds: stringList(input.doNotRepeatActionIds),
    ...(partial
      ? {
          partialResponse: {
            text: safe(partial.text),
            ...(opt(partial.finishReason).value
              ? { finishReason: opt(partial.finishReason).value }
              : {}),
            ...(opt(partial.continuationHint).value
              ? { continuationHint: opt(partial.continuationHint).value }
              : {}),
            checkpoints: sortById(
              array(partial.checkpoints, (entry) => ({
                id: safe(entry.id),
                offset: safeInteger(entry.offset),
                summary: safe(entry.summary),
                completedActionIds: stringList(entry.completedActionIds),
              })),
            ),
          },
        }
      : {}),
  };
  return payload;
}

function compressCapsule(
  capsule: Omit<HandoffCapsule, "integrity">,
  policy: CapsuleCompressionPolicy,
  level: "large" | "small",
): Omit<HandoffCapsule, "integrity"> {
  const limit = level === "large" ? 2_048 : 384;
  const text = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : truncate(value, limit, policy);
  const optionalText = (value: string | undefined, key: string): Record<string, string> => {
    const next = text(value);
    return next ? { [key]: next } : {};
  };
  const semantic = policy === "semantic";
  const omissions = new Set(capsule.compression.omissions);
  omissions.add(`${policy}:${level}`);
  if (semantic) {
    omissions.add("workspace.raw-diffs");
    omissions.add("command-test-tool.raw-output");
    omissions.add("context.raw-content");
  }

  return {
    ...capsule,
    compression: {
      policy,
      compressed: true,
      omissions: [...omissions].sort(compare),
    },
    plan: capsule.plan.map((entry) => ({
      ...entry,
      ...optionalText(text(entry.details), "details"),
      ...(level === "small" ? { blockers: entry.blockers.map((v) => truncate(v, limit, policy)) } : {}),
    })),
    decisions: capsule.decisions.map((entry) => ({
      ...entry,
      rationale: truncate(entry.rationale, limit, policy),
      alternatives:
        level === "small"
          ? entry.alternatives.map((value) => truncate(value, limit, policy))
          : entry.alternatives,
    })),
    assumptions: capsule.assumptions.map((entry) => ({
      ...entry,
      ...optionalText(text(entry.riskIfWrong), "riskIfWrong"),
    })),
    workspace: {
      modifiedFiles: capsule.workspace.modifiedFiles.map(({ diff, summary, ...entry }) => ({
        ...entry,
        ...optionalText(text(summary), "summary"),
        ...(!semantic ? optionalText(text(diff), "diff") : {}),
      })),
      commands: capsule.workspace.commands.map(({ output, summary, ...entry }) => ({
        ...entry,
        ...optionalText(text(summary), "summary"),
        ...(!semantic ? optionalText(text(output), "output") : {}),
      })),
      tests: capsule.workspace.tests.map(({ output, ...entry }) => ({
        ...entry,
        summary: truncate(entry.summary, limit, policy),
        ...(!semantic ? optionalText(text(output), "output") : {}),
      })),
    },
    tools: {
      outcomes: capsule.tools.outcomes.map(({ output, partialEffect, ...entry }) => ({
        ...entry,
        summary: truncate(entry.summary, limit, policy),
        ...(!semantic ? optionalText(text(output), "output") : {}),
        ...optionalText(text(partialEffect), "partialEffect"),
      })),
      pendingApprovals: capsule.tools.pendingApprovals.map((entry) => ({
        ...entry,
        description: truncate(entry.description, limit, policy),
      })),
    },
    contextManifest: capsule.contextManifest.map(({ content, ...entry }) => ({
      ...entry,
      reason: truncate(entry.reason, limit, policy),
      ...(!semantic ? optionalText(text(content), "content") : {}),
    })),
    ...(capsule.partialResponse
      ? {
          partialResponse: {
            ...capsule.partialResponse,
            text: truncate(capsule.partialResponse.text, level === "large" ? 8_192 : 1_024, policy),
            checkpoints: capsule.partialResponse.checkpoints.map((entry) => ({
              ...entry,
              summary: truncate(entry.summary, limit, policy),
            })),
          },
        }
      : {}),
  };
}

function createRedactor(options: HandoffCapsuleOptions): (text: string) => string {
  const secrets = [...(options.secrets ?? [])].filter((secret) => secret.length >= 6);
  return (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    out = out
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, REDACTED)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED}`)
      .replace(
        /(\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?)([^"',;\s}]+)/giu,
        `$1${REDACTED}`,
      )
      .replace(/\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/gu, REDACTED);
    return options.redact ? options.redact(out) : out;
  };
}

function signCapsule(
  unsigned: Omit<HandoffCapsule, "integrity">,
  integrityKey?: Uint8Array | string,
): HandoffCapsule {
  if (integrityKey !== undefined) {
    return {
      ...unsigned,
      integrity: {
        algorithm: "hmac-sha256",
        hash: authenticatedIntegrityHash(unsigned, integrityKey),
      },
    };
  }
  return {
    ...unsigned,
    integrity: { algorithm: "sha256", hash: integrityHash(unsigned) },
  };
}

function requireIntegrityKey(value: Uint8Array | string | undefined): Uint8Array | string {
  if (value === undefined || (typeof value === "string" && value.length === 0)) {
    throw new HandoffCapsuleIntegrityError();
  }
  return value;
}

function authenticatedIntegrityHash(
  unsigned: Omit<HandoffCapsule, "integrity">,
  integrityKey: Uint8Array | string,
): string {
  return `hmac-sha256:${createHmac("sha256", integrityKey)
    .update(canonicalStringify(unsigned), "utf8")
    .digest("hex")}`;
}

function integrityHash(unsigned: Omit<HandoffCapsule, "integrity">): string {
  return `sha256:${createHash("sha256").update(canonicalStringify(unsigned), "utf8").digest("hex")}`;
}

function fitsBudget(capsule: HandoffCapsule, options: ResolvedOptions): boolean {
  const serialized = canonicalStringify(capsule);
  return (
    Buffer.byteLength(serialized, "utf8") <= options.maxBytes &&
    options.estimateTokens(serialized) <= options.maxTokens
  );
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compare)) {
      const entry = value[key];
      if (entry !== undefined) out[key] = canonicalValue(entry);
    }
    return out;
  }
  return value;
}

function truncate(value: string, maxChars: number, policy: CapsuleCompressionPolicy): string {
  if (value.length <= maxChars) return value;
  if (maxChars < 32) return value.slice(0, maxChars);
  const marker = policy === "semantic" ? "\n… <semantic detail omitted> …\n" : "\n… <middle omitted> …\n";
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (remaining - head))}`;
}

function validateInput(input: HandoffCapsuleInput): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ["input must be an object"];
  validateEndpoint(input.source, "source", errors, true);
  validateEndpoint(input.target, "target", errors, false);
  validateGoal(input.goal, errors);
  return errors;
}

function validateEndpoint(
  value: unknown,
  path: "source" | "target",
  errors: string[],
  source: boolean,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requiredString(value, "providerId", errors, path);
  if (source) {
    requiredString(value, "sessionId", errors, path);
    requiredString(value, "runId", errors, path);
    if (!Number.isInteger(value.turn) || (value.turn as number) < 0) {
      errors.push(`${path}.turn must be a non-negative integer`);
    }
  }
}

function validateGoal(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("goal must be an object");
    return;
  }
  requiredString(value, "objective", errors, "goal");
  requiredString(value, "currentGoal", errors, "goal");
  if (!Array.isArray(value.successCriteria)) errors.push("goal.successCriteria must be an array");
}

function validateHandoff(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("handoff must be an object");
    return;
  }
  if (value.mode !== "full" && value.mode !== "consult") errors.push("handoff.mode is invalid");
  if (!Number.isInteger(value.preventRetryWindow) || (value.preventRetryWindow as number) <= 0) {
    errors.push("handoff.preventRetryWindow must be a positive integer");
  }
  if (typeof value.canExecuteActions !== "boolean") {
    errors.push("handoff.canExecuteActions must be boolean");
  }
  if (
    (value.mode === "consult" && value.canExecuteActions !== false) ||
    (value.mode === "full" && value.canExecuteActions !== true)
  ) {
    errors.push("handoff.canExecuteActions does not match mode");
  }
}

function validateCompression(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("compression must be an object");
    return;
  }
  if (value.policy !== "semantic" && value.policy !== "truncateMiddle") {
    errors.push("compression.policy is invalid");
  }
  if (typeof value.compressed !== "boolean") errors.push("compression.compressed must be boolean");
  if (!Array.isArray(value.omissions)) errors.push("compression.omissions must be an array");
}

function collectDuplicateIds(value: Record<string, unknown>, errors: string[]): void {
  const locations: [string, unknown, string][] = [
    ["plan", value.plan, "id"],
    ["decisions", value.decisions, "id"],
    ["assumptions", value.assumptions, "id"],
    ["constraints", value.constraints, "id"],
    ["unresolvedQuestions", value.unresolvedQuestions, "id"],
    ["contextManifest", value.contextManifest, "id"],
  ];
  if (isRecord(value.workspace)) {
    locations.push(["workspace.commands", value.workspace.commands, "id"]);
    locations.push(["workspace.tests", value.workspace.tests, "id"]);
  }
  if (isRecord(value.tools)) {
    locations.push(["tools.outcomes", value.tools.outcomes, "actionId"]);
    locations.push(["tools.pendingApprovals", value.tools.pendingApprovals, "actionId"]);
  }
  for (const [path, entries, key] of locations) {
    if (!Array.isArray(entries)) continue;
    const ids = entries
      .filter(isRecord)
      .map((entry) => entry[key])
      .filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push(`${path} contains duplicate ${key} values`);
  }
}

function validateEntityArray(
  value: unknown,
  path: string,
  idKey: string,
  requiredFields: string[],
  errors: string[],
): void {
  if (!Array.isArray(value)) return;
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`${path}[${index}] must be an object`);
      continue;
    }
    requiredString(entry, idKey, errors, `${path}[${index}]`);
    for (const field of requiredFields) {
      requiredString(entry, field, errors, `${path}[${index}]`);
    }
  }
}

function validateStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) return;
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    }
  }
}

function collectUnknownRootKeys(value: Record<string, unknown>, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!ROOT_KEYS.has(key)) errors.push(`unknown root field: ${key}`);
  }
}

const ROOT_KEYS = new Set([
  "schema",
  "createdAt",
  "handoff",
  "compression",
  "source",
  "target",
  "goal",
  "plan",
  "decisions",
  "assumptions",
  "constraints",
  "unresolvedQuestions",
  "workspace",
  "tools",
  "contextManifest",
  "partialResponse",
  "doNotRepeatActionIds",
  "integrity",
]);

function requiredString(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix?: string,
): void {
  if (typeof value[key] !== "string" || (value[key] as string).trim().length === 0) {
    errors.push(`${prefix ? `${prefix}.` : ""}${key} must be a non-empty string`);
  }
}

function requiredStringAllowEmpty(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix?: string,
): void {
  if (typeof value[key] !== "string") {
    errors.push(`${prefix ? `${prefix}.` : ""}${key} must be a string`);
  }
}

function normalizeCreatedAt(
  value: string | undefined,
  strictness: CapsuleValidationStrictness,
): string {
  if (value === undefined) return new Date().toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    if (strictness === "strict") {
      throw new HandoffCapsuleValidationError(["createdAt must be an ISO timestamp"]);
    }
    return new Date(0).toISOString();
  }
  return new Date(timestamp).toISOString();
}

function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function workStatus(value: unknown): WorkStatus {
  return value === "in-progress" ||
    value === "completed" ||
    value === "blocked" ||
    value === "cancelled"
    ? value
    : "pending";
}

function outcomeStatus(value: unknown): OutcomeStatus {
  return value === "in-progress" ||
    value === "success" ||
    value === "partial" ||
    value === "failure"
    ? value
    : "pending";
}

function testStatus(value: unknown): CapsuleTestRun["status"] {
  return value === "passed" || value === "failed" || value === "partial" ? value : "not-run";
}

function constraintKind(value: unknown): CapsuleConstraint["kind"] {
  return value === "should" || value === "must-not" ? value : "must";
}

function constraintSource(value: unknown): CapsuleConstraint["source"] {
  return value === "system" || value === "project" || value === "inferred" ? value : "user";
}

function fileStatus(value: unknown): CapsuleModifiedFile["status"] {
  return value === "added" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "untracked"
    ? value
    : "modified";
}

function sortById<T extends { id: string }>(values: T[]): T[] {
  return values.sort((a, b) => compare(a.id, b.id));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
