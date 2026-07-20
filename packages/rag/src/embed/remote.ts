/**
 * Real, network-backed embedder seams (system-spec §16 + §2 "embeddings").
 *
 * These are the production embedders. They are NEVER exercised by the test suite
 * (which uses {@link HashingEmbedder}); they exist so the same {@link Embedder}
 * interface can be backed by a local Ollama model or the OpenAI embeddings API in
 * real deployments. Both batch through a single HTTP round-trip and validate the
 * returned dimensionality.
 */

import { OLLAMA_DEFAULT_BASE_URL } from "@nexuscode/provider-ollama";
import type { Embedder } from "../types.js";

/** Minimal fetch surface (injectable for future testing without a global mock). */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function resolveFetch(f?: FetchLike): FetchLike {
  const g = f ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!g) throw new Error("rag: no fetch available; pass one via options.fetch");
  return g;
}

// ── Ollama ─────────────────────────────────────────────────────────────────────

export interface OllamaEmbedderOptions {
  /** Model name served by Ollama (e.g. `"nomic-embed-text"`). Required. */
  model: string;
  /** Vector dimensionality the model produces. Required (used to size the store). */
  dims: number;
  /** OpenAI-compat base URL (default: the ollama provider's `localhost:11434/v1`). */
  baseURL?: string;
  id?: string;
  fetch?: FetchLike;
}

/**
 * Embedder backed by a local Ollama server via its OpenAI-compatible
 * `/v1/embeddings` endpoint. Reuses the ollama provider's base URL by default so
 * there is a single source of truth for where the local server lives.
 */
export function createOllamaEmbedder(opts: OllamaEmbedderOptions): Embedder {
  const baseURL = opts.baseURL ?? OLLAMA_DEFAULT_BASE_URL;
  const doFetch = resolveFetch(opts.fetch);
  return {
    id: opts.id ?? `ollama:${opts.model}`,
    dims: opts.dims,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await doFetch(`${baseURL.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) {
        throw new Error(`ollama embeddings failed: ${res.status} ${res.statusText}`);
      }
      return parseOpenAIEmbeddings(await res.json(), opts.dims);
    },
  };
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

export interface OpenAIEmbedderOptions {
  /** Model name (e.g. `"text-embedding-3-small"`). Required. */
  model: string;
  /** Vector dimensionality the model produces. Required. */
  dims: number;
  /** API key. Required for the real endpoint. */
  apiKey: string;
  /** Base URL (default OpenAI's public API). */
  baseURL?: string;
  id?: string;
  fetch?: FetchLike;
}

/** Embedder backed by the OpenAI (or any OpenAI-compatible) embeddings API. */
export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const baseURL = opts.baseURL ?? "https://api.openai.com/v1";
  const doFetch = resolveFetch(opts.fetch);
  return {
    id: opts.id ?? `openai:${opts.model}`,
    dims: opts.dims,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await doFetch(`${baseURL.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) {
        throw new Error(`openai embeddings failed: ${res.status} ${res.statusText}`);
      }
      return parseOpenAIEmbeddings(await res.json(), opts.dims);
    },
  };
}

/** Parse the OpenAI `{ data: [{ index, embedding }] }` shape, ordered by `index`. */
function parseOpenAIEmbeddings(body: unknown, dims: number): number[][] {
  const data = (body as { data?: Array<{ index?: number; embedding?: number[] }> }).data;
  if (!Array.isArray(data)) throw new Error("embeddings response missing `data` array");
  const rows = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r) => {
    const v = r.embedding;
    if (!Array.isArray(v)) throw new Error("embeddings response missing `embedding`");
    if (v.length !== dims) {
      throw new Error(`embedding dim mismatch: expected ${dims}, got ${v.length}`);
    }
    return v;
  });
}
