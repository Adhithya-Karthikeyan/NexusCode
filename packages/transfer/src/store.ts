/**
 * KnowledgeItem store + Knowledge Graph + FTS5.
 *
 * Materializes `zlcts_items`, `zlcts_graph_nodes`, `zlcts_graph_edges`. FTS5 is
 * kept in sync by the triggers defined in migrate.ts. The non-overwrite rule
 * (newer revision + higher confidence wins) is enforced in `put`.
 */

import type {
  GraphEdge,
  GraphNode,
  ItemKind,
  ItemStatus,
  KnowledgeItem,
  Link,
  Provenance,
  Reasoning,
  Scope,
  Verification,
} from "./items.js";
import { makeEmbeddingKey } from "./items.js";
import type { DbLike } from "./migrate.js";

/** Filter for `list`. */
export interface ListFilter {
  kind?: ItemKind;
  scope?: Scope;
  status?: ItemStatus;
}

/** The item store + KG surface. */
export interface ItemStore {
  put(item: KnowledgeItem): void;
  get(id: string): KnowledgeItem | null;
  list(filter: ListFilter): KnowledgeItem[];
  searchFTS(query: string, limit: number): KnowledgeItem[];
  supersede(id: string, byId: string): void;
  putNode(node: GraphNode): void;
  putEdge(edge: GraphEdge): void;
  neighbors(
    nodeId: string,
    depth: number,
    opts?: { tentativeOk?: boolean },
  ): { nodes: GraphNode[]; edges: GraphEdge[] };
}

/** Create an ItemStore over the given db. */
export function createItemStore(db: DbLike): ItemStore {
  const getItem = db.prepare(`SELECT * FROM zlcts_items WHERE id = ?`);
  const insItem = db.prepare(
    `INSERT INTO zlcts_items
       (id, kind, scope, title, body, why_gloss, rationale_json, fields_json,
        importance, confidence, staleness, status, revision, superseded_by,
        created_at, updated_at, last_verified_at, ttl_ms, tags, links_json,
        embedding_key, source_json, verification_json, embedding_vector)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const updItem = db.prepare(
    `UPDATE zlcts_items SET
       kind = ?, scope = ?, title = ?, body = ?, why_gloss = ?, rationale_json = ?,
       fields_json = ?, importance = ?, confidence = ?, staleness = ?, status = ?,
       revision = ?, superseded_by = ?, created_at = ?, updated_at = ?,
       last_verified_at = ?, ttl_ms = ?, tags = ?, links_json = ?, embedding_key = ?,
       source_json = ?, verification_json = ?
     WHERE id = ?`,
  );

  return {
    put(item: KnowledgeItem): void {
      const existing = getItem.get(item.id) as ItemRow | undefined;
      if (existing) {
        const existingRevision = existing.revision;
        const existingConfidence = existing.confidence;
        const incomingWins =
          item.revision > existingRevision ||
          (item.revision === existingRevision && item.confidence > existingConfidence);
        if (!incomingWins) return; // non-overwrite: caller handles contradiction
        updItem.run(
          item.kind,
          item.scope,
          item.title,
          item.body,
          item.whyGloss ? JSON.stringify(item.whyGloss) : null,
          item.rationale ? JSON.stringify(item.rationale) : null,
          null,
          item.importance,
          item.confidence,
          item.staleness,
          item.status,
          item.revision,
          item.supersededBy ?? null,
          item.createdAt,
          item.updatedAt,
          item.lastVerifiedAt,
          item.ttlMs ?? null,
          JSON.stringify(item.tags),
          JSON.stringify(item.links),
          item.embeddingKey,
          JSON.stringify(item.source),
          item.verification ? JSON.stringify(item.verification) : null,
          item.id,
        );
        return;
      }
      insItem.run(
        item.id,
        item.kind,
        item.scope,
        item.title,
        item.body,
        item.whyGloss ? JSON.stringify(item.whyGloss) : null,
        item.rationale ? JSON.stringify(item.rationale) : null,
        null,
        item.importance,
        item.confidence,
        item.staleness,
        item.status,
        item.revision,
        item.supersededBy ?? null,
        item.createdAt,
        item.updatedAt,
        item.lastVerifiedAt,
        item.ttlMs ?? null,
        JSON.stringify(item.tags),
        JSON.stringify(item.links),
        item.embeddingKey,
        JSON.stringify(item.source),
        item.verification ? JSON.stringify(item.verification) : null,
      );
    },

    get(id: string): KnowledgeItem | null {
      const row = getItem.get(id) as ItemRow | undefined;
      return row ? deserializeItem(row) : null;
    },

    list(filter: ListFilter): KnowledgeItem[] {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.kind) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter.scope) {
        where.push("scope = ?");
        params.push(filter.scope);
      }
      if (filter.status) {
        where.push("status = ?");
        params.push(filter.status);
      }
      const sql = `SELECT * FROM zlcts_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`;
      const rows = db.prepare(sql).all(...params) as ItemRow[];
      return rows.map(deserializeItem);
    },

    searchFTS(query: string, limit: number): KnowledgeItem[] {
      // FTS5 MATCH against the external-content index, join back to base table.
      const rows = db
        .prepare(
          `SELECT i.* FROM zlcts_items_fts f
           JOIN zlcts_items i ON i.rowid = f.rowid
           WHERE zlcts_items_fts MATCH ? AND i.status = 'active'
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, limit) as ItemRow[];
      return rows.map(deserializeItem);
    },

    supersede(id: string, byId: string): void {
      const row = getItem.get(id) as ItemRow | undefined;
      if (!row) return;
      db.prepare(
        `UPDATE zlcts_items SET status = 'superseded', superseded_by = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      ).run(byId, Date.now(), id);
    },

    putNode(node: GraphNode): void {
      db.prepare(
        `INSERT OR REPLACE INTO zlcts_graph_nodes
           (node_id, version, type, label, attrs_json, item_refs_json, created_at, superseded_by, coverage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        node.id,
        node.version,
        node.type,
        node.label,
        JSON.stringify(node.attrs),
        JSON.stringify(node.itemRefs),
        new Date().toISOString(),
        node.supersededBy ?? null,
        node.coverage ?? "full",
      );
    },

    putEdge(edge: GraphEdge): void {
      db.prepare(
        `INSERT OR REPLACE INTO zlcts_graph_edges
           (edge_id, version, from_node, to_node, kind, w, confidence, verified, attrs_json, created_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        edge.edgeId,
        edge.version,
        edge.from,
        edge.to,
        edge.kind,
        edge.w ?? null,
        edge.confidence ?? null,
        edge.verified ? 1 : 0,
        null,
        new Date().toISOString(),
        edge.supersededBy ?? null,
      );
    },

    neighbors(nodeId, depth, opts) {
      const tentativeOk = opts?.tentativeOk ?? false;
      const visited = new Set<string>();
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      // BFS
      let frontier: string[] = [nodeId];
      for (let d = 0; d < depth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const current of frontier) {
          if (visited.has(current)) continue;
          visited.add(current);
          const nodeRow = db
            .prepare(
              `SELECT * FROM zlcts_graph_nodes WHERE node_id = ? AND superseded_by IS NULL
               ORDER BY version DESC LIMIT 1`,
            )
            .get(current) as GraphNodeRow | undefined;
          if (!nodeRow) continue;
          nodes.push(deserializeNode(nodeRow));
          // Outgoing edges (not superseded). Exclude tentative unless tentativeOk.
          const edgeRows = db
            .prepare(
              `SELECT * FROM zlcts_graph_edges WHERE from_node = ? AND superseded_by IS NULL
               ORDER BY version DESC`,
            )
            .all(current) as GraphEdgeRow[];
          for (const er of edgeRows) {
            const edge = deserializeEdge(er);
            if (!tentativeOk && isTentative(edge)) continue;
            edges.push(edge);
            if (!visited.has(er.to_node)) next.push(er.to_node);
          }
        }
        frontier = next;
      }
      return { nodes, edges };
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

interface GraphNodeRow {
  node_id: string;
  version: number;
  type: string;
  label: string | null;
  attrs_json: string | null;
  item_refs_json: string | null;
  created_at: string;
  superseded_by: string | null;
  coverage: string | null;
}

interface GraphEdgeRow {
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

function deserializeItem(row: ItemRow): KnowledgeItem {
  const item: KnowledgeItem = {
    id: row.id,
    kind: row.kind as ItemKind,
    scope: row.scope as Scope,
    title: row.title,
    body: row.body,
    importance: row.importance,
    confidence: row.confidence,
    staleness: row.staleness,
    status: row.status as ItemStatus,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    tags: safeParse<string[]>(row.tags, []),
    links: safeParse<Link[]>(row.links_json, []),
    embeddingKey: row.embedding_key,
    source: safeParse<Provenance>(row.source_json, { origin: "inferred", ref: "" }),
  };
  if (row.why_gloss) item.whyGloss = safeParse<string[]>(row.why_gloss, []);
  if (row.rationale_json) item.rationale = safeParse<Reasoning>(row.rationale_json, emptyReasoning());
  if (row.superseded_by) item.supersededBy = row.superseded_by;
  if (row.ttl_ms !== null) item.ttlMs = row.ttl_ms;
  if (row.verification_json) {
    item.verification = safeParse<Verification>(row.verification_json, {
      lastChecked: 0,
      drift: 0,
    });
  }
  return item;
}

function emptyReasoning(): Reasoning {
  return {
    why: "",
    alternatives: [],
    assumptionsHeld: [],
    evidence: [],
    origin: "unavailable",
    confidence: 0,
  };
}

function deserializeNode(row: GraphNodeRow): GraphNode {
  const node: GraphNode = {
    id: row.node_id,
    version: row.version,
    type: row.type as GraphNode["type"],
    label: row.label ?? "",
    attrs: safeParse<Record<string, unknown>>(row.attrs_json, {}),
    itemRefs: safeParse<string[]>(row.item_refs_json, []),
  };
  if (row.superseded_by) node.supersededBy = row.superseded_by;
  if (row.coverage) node.coverage = row.coverage as "full" | "partial";
  return node;
}

function deserializeEdge(row: GraphEdgeRow): GraphEdge {
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

/** An edge is tentative when unverified AND confidence < 0.8. */
function isTentative(edge: GraphEdge): boolean {
  const conf = edge.confidence ?? 1;
  return !edge.verified && conf < 0.8;
}

/** Re-export makeEmbeddingKey for convenience (used by callers building items). */
export { makeEmbeddingKey };