/**
 * ZLCTS data model — THE contract for the Provider-Neutral Knowledge Core.
 *
 * Every capture-path module (store, wal, sync, projector, verbatim, tool-progress)
 * revolves around these types. Be precise and exhaustive here; downstream phases
 * (rollback, packaging, validation) depend on this shape being stable.
 *
 * No remote LLM calls. The reasoning tagger is rules-only (a pinned local model
 * lands in a later phase).
 */

import type { ContentBlock, Message } from "@nexuscode/shared";

/** The 22 provider-neutral item kinds. */
export type ItemKind =
  | "architecture"
  | "module"
  | "api"
  | "data-model"
  | "business-concept"
  | "file-fact"
  | "test"
  | "service"
  | "convention"
  | "insight"
  | "task"
  | "work-done"
  | "decision"
  | "failure"
  | "assumption"
  | "constraint"
  | "intent"
  | "todo"
  | "reasoning"
  | "open-question"
  | "execution-event"
  | "rollback-info";

/** Knowledge lifetime scope. */
export type Scope = "working" | "session" | "project" | "permanent";

/** Lifecycle status of an item. */
export type ItemStatus =
  | "active"
  | "superseded"
  | "refuted"
  | "stale"
  | "quarantined"
  | "archived";

/** Typed relationships between items / graph nodes. */
export type EdgeKind =
  | "depends-on"
  | "blocks"
  | "supersedes"
  | "refutes"
  | "implements"
  | "part-of"
  | "caused-by"
  | "evidence-for"
  | "alternative-to"
  | "related"
  | "calls"
  | "imports"
  | "defines"
  | "tests"
  | "produces"
  | "consumes"
  | "contains"
  | "references"
  | "contradicts";

/** A typed link from one item to another. */
export interface Link {
  kind: EdgeKind;
  to: string;
  weight?: number;
  confidence?: number;
}

/** Where a piece of knowledge came from. */
export interface Provenance {
  origin: "user" | "provider" | "file" | "inferred" | "test" | "git";
  ref: string;
  providerId?: string;
  rampingUp?: boolean;
  authorityScope?: { subAgentId: string; scopeClaim: string };
}

/** A reference into a typed entity (item, node, message, blob…). */
export interface Ref {
  kind: string;
  id: string;
}

/** A probe used to verify an item (Phase 3 verification path). */
export interface ProbeTask {
  id: string;
  targetsItemId: string;
  type:
    | "recall"
    | "relation"
    | "rationale"
    | "failure"
    | "plan"
    | "apply"
    | "withheld-evidence"
    | "counterfactual";
  prompt: string;
  expected: ExpectedAnswer;
  weight: number;
}

/** The expected answer for a verification probe. */
export interface ExpectedAnswer {
  kind: string;
  value: unknown;
  graphNodeIds?: string[];
}

/** Structured rationale attached to an item. */
export interface Reasoning {
  why: string;
  whyRaw?: string;
  alternatives: { option: string; rejectedBecause: string }[];
  assumptionsHeld: string[];
  evidence: Ref[];
  predecessorId?: string;
  inferredBy?: { modelId: string; modelVersion: string; promptHash: string };
  origin: "emitted" | "inferred" | "unavailable";
  confidence: number;
  coverage?: number;
}

/** Verification metadata on an item. */
export interface Verification {
  probe?: ProbeTask;
  lastChecked: number;
  drift: number;
}

/**
 * A single provider-neutral knowledge item — the atom of the PNKC.
 * Stored as one row in `zlcts_items`; sub-fields serialize to `fields_json`.
 */
export interface KnowledgeItem {
  id: string; // ULID
  kind: ItemKind;
  scope: Scope;
  title: string; // ≤120 chars
  body: string;
  whyGloss?: string[];
  rationale?: Reasoning;
  importance: number; // [0,1] default 0.5
  confidence: number; // [0,1] default 0.5
  staleness: number; // [0,1] default 0
  status: ItemStatus;
  revision: number; // default 1
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number;
  ttlMs?: number;
  links: Link[];
  tags: string[];
  embeddingKey: string;
  source: Provenance;
  verification?: Verification;
  vendorReasoningTokens?: Record<string, string>;
}

/* ----------------------------- Sub-field types ----------------------------- */
/* Stored as `fields_json` on the item row, keyed by kind. */

export interface DecisionOption {
  id: string;
  label: string;
  sketch: string;
}

export interface DecisionFields {
  options: DecisionOption[];
  chosen: string;
  rejectedBecause: Record<string, string>;
  reversibility: "reversible" | "hard-to-reverse" | "irreversible";
  impacts: string[];
  authorityScope?: { subAgentId: string; scopeClaim: string };
}

export interface ApproachSignature {
  tool: string;
  targetPattern: string;
  keyArgs: string[];
  embedding: number[];
}

export interface FailureFields {
  attemptId: string;
  goal: string;
  approach: string;
  approachSignature: ApproachSignature;
  outcome:
    | "error"
    | "wrong"
    | "regression"
    | "rejected"
    | "dead-end"
    | "flaky"
    | "aborted";
  symptom: string;
  rootCause?: string;
  rejectionReason?: string;
  alternativesTried: string[];
  lesson: string;
  preventRetry: boolean;
  reproduces?: boolean;
  partialResult?: { touchedFiles: string[]; partialOutputRef: string };
  confidenceFloor?: number;
}

export interface TaskFields {
  parentId: string | null;
  spec: string;
  progress: number;
  subtasks: string[];
  relatedKids: string[];
  relatedFiles: string[];
  blockers: string[];
  attempts: string[];
  requiredCapabilities: string[];
  startedAt?: number;
  completedAt?: number;
}

export interface Constraint {
  kind: "must" | "should" | "must-not";
  text: string;
  origin: "user" | "inferred" | "system";
  confidence: number;
}

export interface Preference {
  key: string;
  value: string;
}

export interface IntentFields {
  goal: string;
  successCriteria: string[];
  constraints: Constraint[];
  preferences: Preference[];
  nonGoals: string[];
  requiredCapabilities: string[];
}

export interface AssumptionFields {
  riskIfWrong: string;
  invalidatedAt?: number;
  referencedBy: string[];
}

export interface EpisodicFields {
  runId: string;
  turnId: string;
  action: string;
  target?: string;
  result: "success" | "failure" | "partial" | "in-progress" | "unknown";
  rawType?: string;
  rawRef?: string;
  projectorVersion: number;
  deltaKids: { added: string[]; updated: string[]; invalidated: string[] };
  deltaFiles: string[];
  tokensIn: number;
  tokensOut: number;
  partialOutputRef?: string;
}

/* ------------------------------- Graph types ------------------------------- */

export interface GraphNode {
  id: string;
  type:
    | "file"
    | "module"
    | "class"
    | "function"
    | "api"
    | "table"
    | "service"
    | "concept"
    | "test"
    | "dep";
  label: string;
  attrs: Record<string, unknown>;
  itemRefs: string[];
  version: number;
  supersededBy?: string;
  coverage?: "full" | "partial";
}

export interface GraphEdge {
  edgeId: string;
  from: string;
  to: string;
  kind: EdgeKind;
  w?: number;
  confidence?: number;
  version: number;
  supersededBy?: string;
  verified: boolean;
}

/**
 * Kinds that must NEVER be compressed/summarized away. file-fact is included
 * because it is the durable ground truth of the repo and is treated specially
 * downstream (it is re-emittable from the repo itself, but until then it is
 * kept verbatim).
 */
export const NEVER_COMPRESS_KINDS: ItemKind[] = [
  "decision",
  "failure",
  "assumption",
  "intent",
  "convention",
  "constraint",
  "file-fact",
];

/* -------------------------------- Helpers ---------------------------------- */

/**
 * Concatenate title + body + whyGloss + tags, lowercased — the canonical input
 * to FTS5 and (later) the embedding model. Pure & deterministic.
 */
export function makeEmbeddingKey(item: {
  title: string;
  body: string;
  whyGloss?: string[];
  tags?: string[];
}): string {
  const why = item.whyGloss ? item.whyGloss.join(" ") : "";
  const tags = item.tags ? item.tags.join(" ") : "";
  return `${item.title} ${item.body} ${why} ${tags}`.toLowerCase();
}

/**
 * Canonical JSON of the stable fields of an item — the input to `stableHash`.
 * Excludes maintained fields (importance/staleness/confidence/lastVerifiedAt/
 * embeddingVector) so re-rating an item does not change its identity hash.
 */
export function stableFieldsOf(item: KnowledgeItem): string {
  const stable = {
    id: item.id,
    kind: item.kind,
    body: item.body,
    rationale: item.rationale ?? null,
    links: item.links,
    status: item.status,
    revision: item.revision,
    supersededBy: item.supersededBy ?? null,
    source: item.source,
  };
  return canonicalJson(stable);
}

/** Deterministic JSON (sorted keys, no whitespace). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/** Expected reasoning fields, used to compute `coverage`. */
const REASONING_EXPECTED: (keyof Reasoning)[] = [
  "why",
  "whyRaw",
  "alternatives",
  "assumptionsHeld",
  "evidence",
  "predecessorId",
  "inferredBy",
  "origin",
  "confidence",
  "coverage",
];

/**
 * A rules-based deterministic reasoning tagger. No remote LLM. Extracts a
 * canonical `why` (first sentence, trimmed), lifts `alternatives` from the
 * provided list, and computes `coverage` as the fraction of expected fields the
 * tagger was able to populate. Non-empty input → origin "inferred", confidence
 * 0.4 (≤0.5 per the rules-only invariant). Empty input → origin "unavailable",
 * confidence 0, why "[unavailable]".
 *
 * A pinned local model replaces this in a later phase; the contract stays.
 */
export function tagReasoning(raw: {
  text: string;
  alternatives?: string[];
}): Reasoning {
  if (!raw.text || raw.text.trim().length === 0) {
    const empty: Reasoning = {
      why: "[unavailable]",
      alternatives: [],
      assumptionsHeld: [],
      evidence: [],
      origin: "unavailable",
      confidence: 0,
      coverage: 0,
    };
    return empty;
  }

  const firstSentence = raw.text.trim().split(/(?<=[.!?])\s+/)[0] ?? raw.text.trim();
  const alternatives = (raw.alternatives ?? []).map((option) => ({
    option,
    rejectedBecause: "",
  }));

  const base: Reasoning = {
    why: firstSentence.trim(),
    alternatives,
    assumptionsHeld: [],
    evidence: [],
    origin: "inferred",
    confidence: 0.4,
  };

  // Count present expected fields (only those the tagger can produce here).
  let present = 0;
  for (const f of REASONING_EXPECTED) {
    const v = base[f];
    if (v !== undefined) {
      if (Array.isArray(v)) {
        if (v.length > 0) present++;
      } else {
        present++;
      }
    }
  }
  base.coverage = present / REASONING_EXPECTED.length;
  return base;
}

/* --------------------------------- ULID ------------------------------------ */

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Minimal ULID: 48-bit ms timestamp (10 chars Crockford) + 80 bits of crypto
 * randomness (16 chars). Monotonic-ish within a process via a random tail.
 * Good enough for item ids; full monotonicity is a later concern.
 */
export function ulid(now: number = Date.now()): string {
  const ts = Math.floor(now);
  let time = "";
  let t = ts;
  for (let i = 9; i >= 0; i--) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < 10; i++) rand += ULID_ALPHABET[bytes[i]! % 32];
  return time + rand;
}

/** Re-export the shared message types used by the projector for convenience. */
export type { ContentBlock, Message };