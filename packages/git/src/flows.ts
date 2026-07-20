/**
 * LLM-driven git flows (system-spec §14) — explain diff, review changes,
 * generate commit message, generate PR description, semantic diff, conflict
 * assist.
 *
 * Every flow takes an injected {@link ProviderAdapter} (the mock in tests, a
 * real provider in production), builds a deterministic prompt from git context,
 * consumes the adapter's *streaming* seam, and returns a typed result. Two hard
 * rules hold throughout:
 *   1. No shell injection — context comes from `context.ts`, which uses
 *      `execFile`. The flows never build a shell command.
 *   2. No secrets — every piece of user/diff content is passed through
 *      `redactSecrets` (`@nexuscode/tools`) before it reaches a provider.
 */

import { randomUUID } from "node:crypto";
import type { CallContext, ProviderAdapter } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";
import { redactSecrets } from "@nexuscode/tools";
import { PromptEngine } from "@nexuscode/prompt";
import type { LogEntry } from "./context.js";

/** Options common to every flow. */
export interface FlowOptions {
  /** Logical model id to request. Default `"mock-fast"` (harmless for real providers to override). */
  model?: string;
  /** Cancellation signal, used when the flow must build its own {@link CallContext}. */
  signal?: AbortSignal;
  /** A pre-built call context (correlation ids, emit sink). One is created if omitted. */
  ctx?: CallContext;
  /** Override the composed system prompt entirely. */
  system?: string;
  /** Receive streamed text deltas as they arrive (in addition to the returned result). */
  onDelta?: (text: string) => void;
}

/** A single, shared prompt engine — reused for deterministic system-prompt composition. */
const engine = new PromptEngine();

/**
 * Compose a deterministic system prompt from an identity + capability lines.
 * Reuses `@nexuscode/prompt`'s `compose`, which fixes section order so the same
 * inputs always serialize identically (prompt-cache stable).
 */
function system(identity: string, capabilities: string[]): string {
  return engine.compose({ identity, capabilities });
}

function buildCtx(opts: FlowOptions): CallContext {
  if (opts.ctx) return opts.ctx;
  const signal = opts.signal ?? new AbortController().signal;
  return {
    signal,
    idempotencyKey: `git_${randomUUID()}`,
    traceId: `git_${randomUUID()}`,
    runId: `git_${randomUUID()}`,
  };
}

function buildRequest(sys: string, userBody: string, model: string): ChatRequest {
  return {
    model,
    system: sys,
    messages: [{ role: "user", content: [{ type: "text", text: userBody }] }],
  };
}

/**
 * Consume the adapter's streaming seam, accumulating answer text. Honors
 * cancellation (a terminal `error` chunk throws) and forwards deltas to
 * `onDelta` when provided.
 */
async function complete(
  adapter: ProviderAdapter,
  req: ChatRequest,
  ctx: CallContext,
  onDelta?: (text: string) => void,
): Promise<string> {
  let text = "";
  for await (const chunk of adapter.stream(req, ctx) as AsyncIterable<StreamChunk>) {
    if (chunk.type === "text-delta") {
      if (chunk.channel === "reasoning") continue;
      text += chunk.text;
      onDelta?.(chunk.text);
    } else if (chunk.type === "error") {
      throw chunk.error;
    }
  }
  return text;
}

/** Run a flow: compose system prompt, redact the body, stream, return raw text. */
async function runFlow(
  adapter: ProviderAdapter,
  opts: FlowOptions,
  sys: string,
  rawBody: string,
): Promise<string> {
  const ctx = buildCtx(opts);
  const model = opts.model ?? "mock-fast";
  const req = buildRequest(opts.system ?? sys, redactSecrets(rawBody), model);
  return complete(adapter, req, ctx, opts.onDelta);
}

// ── explainDiff ─────────────────────────────────────────────────────────────

const EXPLAIN_SYS = system(
  "You are a senior software engineer who explains code changes clearly and concisely.",
  [
    "Read a unified git diff and describe, in plain natural language, what the change does and why it matters.",
    "Do not restate the diff line-by-line; summarize intent and impact.",
  ],
);

/** Explain a unified diff in natural language. */
export function explainDiff(
  adapter: ProviderAdapter,
  diffText: string,
  opts: FlowOptions = {},
): Promise<string> {
  const body = `Explain the following git diff:\n\n${diffText}`;
  return runFlow(adapter, opts, EXPLAIN_SYS, body);
}

// ── reviewChanges ───────────────────────────────────────────────────────────

export type ReviewSeverity = "info" | "warning" | "error";

export interface ReviewComment {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  message: string;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  /** The raw model output, before parsing. */
  raw: string;
}

const REVIEW_SYS = system(
  "You are a meticulous code reviewer.",
  [
    "Review a unified git diff for correctness, clarity, security, and style issues.",
    'Respond ONLY with JSON: {"summary": string, "comments": [{"severity": "info"|"warning"|"error", "file"?: string, "line"?: number, "message": string}]}.',
  ],
);

const VALID_SEVERITY = new Set<ReviewSeverity>(["info", "warning", "error"]);

function coerceComment(value: unknown): ReviewComment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const message = typeof v.message === "string" ? v.message : undefined;
  if (!message) return undefined;
  const severity =
    typeof v.severity === "string" && VALID_SEVERITY.has(v.severity as ReviewSeverity)
      ? (v.severity as ReviewSeverity)
      : "info";
  const out: ReviewComment = { severity, message };
  if (typeof v.file === "string") out.file = v.file;
  if (typeof v.line === "number" && Number.isFinite(v.line)) out.line = v.line;
  return out;
}

/**
 * Parse a model's review output. Prefers structured JSON (what a real provider
 * returns); falls back to wrapping the raw text as a single info comment so the
 * flow still yields a usable structure with any provider (e.g. the echo mock).
 */
function parseReview(raw: string): ReviewResult {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const p = parsed as Record<string, unknown>;
        const commentsSrc = Array.isArray(p.comments) ? p.comments : [];
        const comments = commentsSrc
          .map(coerceComment)
          .filter((c): c is ReviewComment => c !== undefined);
        const summary = typeof p.summary === "string" ? p.summary : "";
        if (comments.length > 0 || summary) {
          return { summary, comments, raw };
        }
      }
    } catch {
      // fall through to the text fallback
    }
  }
  const summary = trimmed.split("\n")[0] ?? "";
  return { summary, comments: [{ severity: "info", message: trimmed }], raw };
}

/** Review a unified diff and return structured comments. */
export async function reviewChanges(
  adapter: ProviderAdapter,
  diffText: string,
  opts: FlowOptions = {},
): Promise<ReviewResult> {
  const body = `Review the following git diff and report issues:\n\n${diffText}`;
  const raw = await runFlow(adapter, opts, REVIEW_SYS, body);
  return parseReview(raw);
}

// ── generateCommitMessage ───────────────────────────────────────────────────

export interface CommitMessage {
  /** The full commit message (header + optional body). */
  message: string;
  /** The subject line (first line). */
  header: string;
  /** Conventional-commit type (`feat`, `fix`, …) when detected. */
  type?: string;
  /** Conventional-commit scope when present. */
  scope?: string;
  /** True when the header carries a breaking-change `!`. */
  breaking: boolean;
  /** The subject text after `type(scope): `. */
  subject: string;
  /** The message body (everything after the blank line), if any. */
  body?: string;
}

const COMMIT_SYS = system(
  "You write clean Conventional Commits messages.",
  [
    "Given a git diff, produce a single Conventional Commit message.",
    "Format the subject as `type(scope): description` (scope optional), max ~72 chars, imperative mood.",
    "Add a blank line and a short body only when it adds real information.",
  ],
);

const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** Parse raw model output into a structured commit message. */
function parseCommitMessage(raw: string): CommitMessage {
  const message = raw.trim();
  const lines = message.split("\n");
  const header = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n").trim();
  const out: CommitMessage = { message, header, breaking: false, subject: header };
  const m = CONVENTIONAL_RE.exec(header);
  if (m) {
    if (m[1]) out.type = m[1];
    if (m[2]) out.scope = m[2];
    out.breaking = m[3] === "!";
    out.subject = m[4] ?? header;
  }
  if (rest.length > 0) out.body = rest;
  return out;
}

/** Generate a Conventional Commit message from a diff. */
export async function generateCommitMessage(
  adapter: ProviderAdapter,
  diffText: string,
  opts: FlowOptions = {},
): Promise<CommitMessage> {
  const body = `Write a Conventional Commit message for this git diff:\n\n${diffText}`;
  const raw = await runFlow(adapter, opts, COMMIT_SYS, body);
  return parseCommitMessage(raw);
}

// ── generatePrDescription ───────────────────────────────────────────────────

export interface PrInput {
  /** Commit log entries on the branch, or a raw commit summary string. */
  commits?: LogEntry[] | string;
  /** The overall branch diff. */
  diff?: string;
}

export interface PrDescription {
  title: string;
  body: string;
  /** The raw model output. */
  raw: string;
}

const PR_SYS = system(
  "You write high-quality pull request descriptions.",
  [
    "Summarize a set of commits and a diff into a PR title and body.",
    "First line is the PR title; the rest is a markdown body with a summary and, when useful, a bullet list of changes.",
  ],
);

function renderCommits(commits: LogEntry[] | string | undefined): string {
  if (!commits) return "";
  if (typeof commits === "string") return commits;
  return commits.map((c) => `- ${c.subject} (${c.hash.slice(0, 8)})`).join("\n");
}

/** Generate a PR title + body from commits and/or a diff. */
export async function generatePrDescription(
  adapter: ProviderAdapter,
  input: PrInput,
  opts: FlowOptions = {},
): Promise<PrDescription> {
  const commitsText = renderCommits(input.commits);
  const sections: string[] = ["Write a pull request title and description."];
  if (commitsText) sections.push(`Commits:\n${commitsText}`);
  if (input.diff) sections.push(`Diff:\n${input.diff}`);
  const raw = await runFlow(adapter, opts, PR_SYS, sections.join("\n\n"));
  const trimmed = raw.trim();
  const nl = trimmed.indexOf("\n");
  const title = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
  const prBody = (nl === -1 ? "" : trimmed.slice(nl + 1)).trim();
  return { title, body: prBody, raw };
}

// ── semanticDiff ────────────────────────────────────────────────────────────

/** A minimal line-level change summary between two versions of a text. */
export interface LineChanges {
  added: string[];
  removed: string[];
}

/**
 * Compute a cheap line-level delta (added/removed lines) between `before` and
 * `after`. This is a set difference, not a true LCS diff — it is only used to
 * feed the model a compact, structured hint, not to render a patch.
 */
export function lineChanges(before: string, after: string): LineChanges {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter((l) => !afterSet.has(l));
  const added = afterLines.filter((l) => !beforeSet.has(l));
  return { added, removed };
}

export interface SemanticDiffResult {
  /** The natural-language, higher-level summary of what changed. */
  summary: string;
  /** The line-level delta fed to the model. */
  changes: LineChanges;
}

const SEMANTIC_SYS = system(
  "You explain code changes at a semantic level.",
  [
    "Given the before and after of a file, describe what changed in terms of behavior and intent — new functions, renamed symbols, changed logic — not line noise.",
  ],
);

/** Summarize, semantically, what changed between two versions of a text. */
export async function semanticDiff(
  adapter: ProviderAdapter,
  before: string,
  after: string,
  opts: FlowOptions = {},
): Promise<SemanticDiffResult> {
  const changes = lineChanges(before, after);
  const body = [
    "Summarize semantically what changed between these two versions.",
    `Removed lines:\n${changes.removed.join("\n") || "(none)"}`,
    `Added lines:\n${changes.added.join("\n") || "(none)"}`,
  ].join("\n\n");
  const summary = await runFlow(adapter, opts, SEMANTIC_SYS, body);
  return { summary, changes };
}

// ── conflictAssist ──────────────────────────────────────────────────────────

export interface ConflictHunk {
  /** The "ours" side (between `<<<<<<<` and `=======`). */
  ours: string;
  /** The "theirs" side (between `=======` and `>>>>>>>`). */
  theirs: string;
}

export interface ConflictResolution {
  /** Parsed conflict hunks found in the file. */
  hunks: ConflictHunk[];
  /** The model's suggested resolution / guidance. */
  resolution: string;
}

const CONFLICT_MARKER = /^<{7}|^={7}|^>{7}/;

/** Extract `<<<<<<< / ======= / >>>>>>>` conflict hunks from file content. */
export function parseConflicts(content: string): ConflictHunk[] {
  const lines = content.split("\n");
  const hunks: ConflictHunk[] = [];
  let state: "none" | "ours" | "theirs" = "none";
  let ours: string[] = [];
  let theirs: string[] = [];
  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      state = "ours";
      ours = [];
      theirs = [];
    } else if (line.startsWith("=======") && state === "ours") {
      state = "theirs";
    } else if (line.startsWith(">>>>>>>") && state === "theirs") {
      hunks.push({ ours: ours.join("\n"), theirs: theirs.join("\n") });
      state = "none";
    } else if (state === "ours") {
      ours.push(line);
    } else if (state === "theirs") {
      theirs.push(line);
    }
  }
  return hunks;
}

const CONFLICT_SYS = system(
  "You are an expert at resolving git merge conflicts safely.",
  [
    "Given a file containing conflict markers, propose a single coherent resolution that preserves the intent of both sides where possible.",
    "Explain briefly why, and never invent code unrelated to the two sides.",
  ],
);

/** Suggest a resolution for a conflicted file's contents. */
export async function conflictAssist(
  adapter: ProviderAdapter,
  conflictedFile: string,
  opts: FlowOptions = {},
): Promise<ConflictResolution> {
  const hunks = parseConflicts(conflictedFile);
  const body = `Resolve the merge conflict(s) in this file:\n\n${conflictedFile}`;
  const resolution = await runFlow(adapter, opts, CONFLICT_SYS, body);
  return { hunks, resolution };
}

/** Remove the `<<<`/`===`/`>>>` marker lines, leaving both sides' content. */
export function stripConflictMarkers(content: string): string {
  return content
    .split("\n")
    .filter((l) => !CONFLICT_MARKER.test(l))
    .join("\n");
}
