/**
 * IntegrityRepair — verify and repair the PNKC.
 *
 * `check` computes a stable hash over all items (active + superseded), lists
 * orphan graph edges, orphan assumption references, unfolded WAL rows, WAL
 * checksum mismatches, and recorded loss events. `repair` acts on the report:
 * deletes orphan edges, restores the latest snapshot + records a DataLoss event
 * when the stable hash changed unexpectedly or WAL payloads are corrupt, and
 * replays unfolded WAL. This is the substrate that makes crashes survivable.
 */

import { createHash } from "node:crypto";
import type { BlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";
import type { GraphEdge } from "./items.js";
import { stableFieldsOf } from "./items.js";
import type { PnkcSnapshotStore } from "./snapshot.js";
import { recoverUnfolded } from "./sync.js";
import { createMutex } from "./mutex.js";

/** The integrity report returned by `check`. */
export interface IntegrityReport {
  /** sha256 over the canonical sorted-by-id concatenation of `stableFieldsOf`. */
  stableHash: string;
  /** true if `stableHash` differs from the last recorded value in zlcts_integrity. */
  hashChanged: boolean;
  /** Graph edges whose from_node or to_node has no unsuperseded node row. */
  orphanEdges: GraphEdge[];
  /**
   * Assumption-kind items whose own `rationale.assumptionsHeld` references point
   * to missing items, OR assumption items that are referenced by others but no
   * longer exist. Interpretation: an assumption is orphan if it cites missing
   * assumptions, or if a non-existent assumption id is cited by a surviving
   * item. Listed by assumption item id (or the missing cited id).
   */
  orphanAssumptions: string[];
  /** Count of WAL rows with folded=0 (unreplayed deltas). */
  unfoldedWal: number;
  /** WAL seqs whose stored checksum != sha256(payload blob bytes). */
  walChecksumMismatches: number[];
  /** Recorded loss history from zlcts_integrity key `loss` (parsed JSON array). */
  lossEvents: unknown[];
}

/** One repair action taken by `repair`. */
export type RepairAction =
  | { kind: "deleted-orphan-edge"; detail: string }
  | { kind: "restored-snapshot"; detail: string }
  | { kind: "replayed-wal"; detail: string }
  | { kind: "recorded-loss"; detail: string };

/** A loss event recorded into the `loss` integrity key. */
export interface LossEvent {
  ts: number;
  reason: string;
  detail: string;
}

/** The IntegrityRepair surface. */
export interface IntegrityRepair {
  check(): IntegrityReport;
  repair(report: IntegrityReport): RepairAction[];
  recordLoss(event: LossEvent): void;
}

/** Create an IntegrityRepair over the given db + blob store + snapshot store. */
export function createIntegrityRepair(
  db: DbLike,
  blobs: BlobStore,
  snapshots: PnkcSnapshotStore,
): IntegrityRepair {
  const getInt = db.prepare(`SELECT v FROM zlcts_integrity WHERE k = ?`);
  const setInt = db.prepare(
    `INSERT INTO zlcts_integrity (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  );

  return {
    check(): IntegrityReport {
      // --- stable hash over all items (active + superseded), sorted by id ---
      const stableHash = computeStableHash(db);

      const prevHashRow = getInt.get("stableHash") as { v?: string } | undefined;
      const prevHash = prevHashRow?.v;
      const hashChanged = prevHash !== undefined && prevHash !== stableHash;

      // --- orphan edges: from_node or to_node has no unsuperseded node ---
      const edgeRows = db
        .prepare(
          `SELECT e.edge_id, e.version, e.from_node, e.to_node, e.kind, e.w, e.confidence,
                  e.verified, e.attrs_json, e.created_at, e.superseded_by
           FROM zlcts_graph_edges e
           WHERE e.superseded_by IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM zlcts_graph_nodes n
               WHERE n.node_id = e.from_node AND n.superseded_by IS NULL)
             OR NOT EXISTS (
               SELECT 1 FROM zlcts_graph_nodes n
               WHERE n.node_id = e.to_node AND n.superseded_by IS NULL)`,
        )
        .all() as EdgeRow[];
      const orphanEdges = edgeRows.map(deserializeEdge);

      // --- orphan assumptions ---
      // Interpretation: an assumption item is orphan if its rationale.assumptionsHeld
      // cites ids that no longer exist as items, OR a surviving item cites an
      // assumption id that no longer exists. We list the missing ids.
      const orphanAssumptions = computeOrphanAssumptions(db);

      // --- unfolded WAL ---
      const walCountRow = db
        .prepare(`SELECT COUNT(*) AS n FROM zlcts_wal WHERE folded = 0`)
        .get() as { n: number };
      const unfoldedWal = walCountRow.n;

      // --- WAL checksum mismatches ---
      const walRows = db
        .prepare(`SELECT seq, payload_ref, checksum FROM zlcts_wal ORDER BY seq ASC`)
        .all() as { seq: number; payload_ref: string; checksum: string }[];
      const walChecksumMismatches: number[] = [];
      for (const w of walRows) {
        const bytes = blobs.get(w.payload_ref);
        if (!bytes) {
          // missing blob = checksum mismatch (cannot verify)
          walChecksumMismatches.push(w.seq);
          continue;
        }
        const actual = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
        if (actual !== w.checksum) walChecksumMismatches.push(w.seq);
      }

      // --- loss events ---
      const lossRow = getInt.get("loss") as { v?: string } | undefined;
      let lossEvents: unknown[] = [];
      if (lossRow?.v) {
        try {
          const parsed = JSON.parse(lossRow.v) as unknown;
          if (Array.isArray(parsed)) lossEvents = parsed;
        } catch {
          lossEvents = [];
        }
      }

      return {
        stableHash,
        hashChanged,
        orphanEdges,
        orphanAssumptions,
        unfoldedWal,
        walChecksumMismatches,
        lossEvents,
      };
    },

    repair(report: IntegrityReport): RepairAction[] {
      const actions: RepairAction[] = [];

      // 1. Delete orphan edges (hard delete — they reference missing nodes and
      //    cannot be traversed; keeping them would corrupt neighbor BFS).
      if (report.orphanEdges.length > 0) {
        db.exec("BEGIN");
        try {
          const delEdge = db.prepare(
            `DELETE FROM zlcts_graph_edges WHERE edge_id = ? AND version = ?`,
          );
          for (const e of report.orphanEdges) {
            delEdge.run(e.edgeId, e.version);
          }
          db.exec("COMMIT");
          actions.push({
            kind: "deleted-orphan-edge",
            detail: `deleted ${report.orphanEdges.length} orphan edge(s)`,
          });
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }

      // 2. If WAL payloads are corrupt OR the stable hash changed unexpectedly,
      //    restore the latest snapshot and record a DataLoss event.
      const needsRestore = report.walChecksumMismatches.length > 0 || report.hashChanged;
      if (needsRestore) {
        // Find the latest snapshot across sessions touched by the report. We
        // pick the most recent snapshot overall (single-session PNKC is the
        // current model); if none exists, skip restore and just record loss.
        const anySnap = db
          .prepare(
            `SELECT snapshot_id FROM zlcts_snapshots ORDER BY lamport_ts DESC, created_at DESC LIMIT 1`,
          )
          .get() as { snapshot_id?: string } | undefined;
        if (anySnap?.snapshot_id) {
          const restored = snapshots.restore(anySnap.snapshot_id);
          actions.push({
            kind: "restored-snapshot",
            detail: `restored snapshot ${anySnap.snapshot_id} (lamport=${restored.lamportTs}, session=${restored.sessionId})`,
          });
        }
        this.recordLoss({
          ts: Date.now(),
          reason:
            report.walChecksumMismatches.length > 0
              ? "wal-checksum-mismatch"
              : "stable-hash-changed",
          detail: `mismatches=${report.walChecksumMismatches.length}; hashChanged=${report.hashChanged}`,
        });
        actions.push({
          kind: "recorded-loss",
          detail: `recorded loss event (reason=${
            report.walChecksumMismatches.length > 0
              ? "wal-checksum-mismatch"
              : "stable-hash-changed"
          })`,
        });
      }

      // 3. Replay unfolded WAL (after any snapshot restore, which may have
      //    truncated some rows). Run recovery under a fresh mutex — startup path.
      if (report.unfoldedWal > 0) {
        const res = recoverUnfolded(db, blobs, createMutex());
        if (res.recovered > 0) {
          actions.push({
            kind: "replayed-wal",
            detail: `replayed ${res.recovered} unfolded WAL row(s) across ${res.sessions.length} session(s)`,
          });
        }
      }

      // 4. Persist the new stable hash so future checks compare against it.
      //    (Done last so a successful repair resets the baseline.) Recompute the
      //    hash from the POST-repair db state — `report.stableHash` was captured
      //    by `check()` BEFORE repair mutated items (snapshot restore DELETE-
      //    INSERTs all items; recoverUnfolded re-folds), so storing it would
      //    leave a stale baseline that makes every subsequent `check()` see
      //    `hashChanged=true` and re-fire repair → cascading false DataLoss.
      const freshHash = computeStableHash(db);
      setInt.run("stableHash", freshHash);

      return actions;
    },

    recordLoss(event: LossEvent): void {
      const lossRow = getInt.get("loss") as { v?: string } | undefined;
      let arr: LossEvent[] = [];
      if (lossRow?.v) {
        try {
          const parsed = JSON.parse(lossRow.v) as unknown;
          if (Array.isArray(parsed)) arr = parsed as LossEvent[];
        } catch {
          arr = [];
        }
      }
      arr.push(event);
      setInt.run("loss", JSON.stringify(arr));
    },
  };
}

/* ------------------------------- helpers ----------------------------------- */

interface ItemRow {
  id: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  why_gloss: string | null;
  rationale_json: string | null;
  fields_json: string | null;
  importance: number;
  confidence: number;
  staleness: number;
  status: string;
  revision: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
  last_verified_at: number;
  ttl_ms: number | null;
  tags: string;
  links_json: string;
  embedding_key: string;
  source_json: string;
  verification_json: string | null;
}

interface EdgeRow {
  edge_id: string;
  version: number;
  from_node: string;
  to_node: string;
  kind: string;
  w: number | null;
  confidence: number | null;
  verified: number;
  attrs_json: string | null;
  created_at: string;
  superseded_by: string | null;
}

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function deserializeItem(row: ItemRow): import("./items.js").KnowledgeItem {
  const item: import("./items.js").KnowledgeItem = {
    id: row.id,
    kind: row.kind as import("./items.js").ItemKind,
    scope: row.scope as import("./items.js").Scope,
    title: row.title,
    body: row.body,
    importance: row.importance,
    confidence: row.confidence,
    staleness: row.staleness,
    status: row.status as import("./items.js").ItemStatus,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    tags: safeParse<string[]>(row.tags, []),
    links: safeParse<import("./items.js").Link[]>(row.links_json, []),
    embeddingKey: row.embedding_key,
    source: safeParse<import("./items.js").Provenance>(row.source_json, {
      origin: "inferred",
      ref: "",
    }),
  };
  if (row.why_gloss) item.whyGloss = safeParse<string[]>(row.why_gloss, []);
  if (row.rationale_json)
    item.rationale = safeParse<import("./items.js").Reasoning>(row.rationale_json, {
      why: "",
      alternatives: [],
      assumptionsHeld: [],
      evidence: [],
      origin: "unavailable",
      confidence: 0,
    });
  if (row.superseded_by) item.supersededBy = row.superseded_by;
  if (row.ttl_ms !== null) item.ttlMs = row.ttl_ms;
  if (row.verification_json)
    item.verification = safeParse<import("./items.js").Verification>(row.verification_json, {
      lastChecked: 0,
      drift: 0,
    });
  return item;
}

function deserializeEdge(row: EdgeRow): GraphEdge {
  const edge: GraphEdge = {
    edgeId: row.edge_id,
    from: row.from_node,
    to: row.to_node,
    kind: row.kind as GraphEdge["kind"],
    version: row.version,
    verified: row.verified === 1,
  };
  if (row.w !== null) edge.w = row.w;
  if (row.confidence !== null) edge.confidence = row.confidence;
  if (row.superseded_by) edge.supersededBy = row.superseded_by;
  return edge;
}

/**
 * Compute orphan assumption references.
 *
 * Interpretation: an assumption is orphan if (a) an item's
 * `rationale.assumptionsHeld` cites an id that is not present in zlcts_items,
 * or (b) an assumption-kind item exists but its own `assumptionsHeld` cites
 * missing items. We collect the missing cited ids (deduped, sorted).
 */
function computeOrphanAssumptions(db: DbLike): string[] {
  const rows = db
    .prepare(`SELECT id, kind, rationale_json FROM zlcts_items`)
    .all() as { id: string; kind: string; rationale_json: string | null }[];
  const existingIds = new Set(rows.map((r) => r.id));
  const missing = new Set<string>();
  for (const r of rows) {
    if (!r.rationale_json) continue;
    const rationale = safeParse<{ assumptionsHeld?: string[] }>(r.rationale_json, {});
    const held = rationale.assumptionsHeld;
    if (!Array.isArray(held)) continue;
    for (const aid of held) {
      if (!existingIds.has(aid)) missing.add(aid);
    }
  }
  return [...missing].sort();
}

/**
 * Recompute the stable hash over all items (active + superseded), sorted by id
 * ASC, mapped through `deserializeItem` → `stableFieldsOf`, joined with "\n",
 * sha256 hex. Shared by `check()` and the final step of `repair()` so the
 * baseline always reflects the db's CURRENT state.
 */
function computeStableHash(db: DbLike): string {
  const itemRows = db
    .prepare(
      `SELECT id, kind, scope, title, body, why_gloss, rationale_json, fields_json,
              importance, confidence, staleness, status, revision, superseded_by,
              created_at, updated_at, last_verified_at, ttl_ms, tags, links_json,
              embedding_key, source_json, verification_json
       FROM zlcts_items ORDER BY id ASC`,
    )
    .all() as ItemRow[];
  const stableConcat = itemRows.map((r) => stableFieldsOf(deserializeItem(r))).join("\n");
  return createHash("sha256").update(stableConcat).digest("hex");
}