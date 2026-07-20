/**
 * Wave-6 command handlers: session management, session replay, the Code Receipt,
 * the observability trace view, and the LLM-driven git flows (commit / review /
 * explain / pr). Every one is offline-verifiable:
 *
 *   - sessions/replay/receipt read the shared SQLite event_log (the single
 *     source of truth) through `@nexuscode/session`;
 *   - `trace` reads the NDJSON span sink written by an instrumented run;
 *   - the git flows shell out to the local `git` binary (execFile, no shell) for
 *     context and run the configured/mocked provider for generation.
 *
 * The Code Receipt is a LOCAL artifact: it is written to disk and its path is
 * printed. Nothing here uploads, publishes, or otherwise leaves the machine.
 */

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadConfig, nexusPaths, type NexusConfig } from "@nexuscode/config";
import {
  SessionStore,
  type ExportFormat,
  type SessionMeta,
} from "@nexuscode/session";
import {
  diff as gitDiff,
  isGitRepo,
  log as gitLog,
  runGit,
  status as gitStatus,
  explainDiff,
  generateCommitMessage,
  generatePrDescription,
  reviewChanges,
  type ReviewResult,
} from "@nexuscode/git";
import type { ProviderAdapter, ProviderRegistry, UiEvent } from "@nexuscode/core";
import type { ParsedArgs } from "./args.js";
import { userConfigDir } from "./config-io.js";
import { buildRuntime } from "./runtime.js";
import {
  buildObservability,
  loadTraceSpans,
  renderTimeline,
  TraceStore,
} from "./observability.js";

export type OutputMode = "text" | "json" | "ndjson";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

function parseOutput(args: ParsedArgs): OutputMode {
  const raw = args.flags.get("output") ?? "text";
  return raw === "json" || raw === "ndjson" || raw === "text" ? raw : "text";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  try {
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadEffectiveConfig(): Promise<NexusConfig> {
  const { config } = await loadConfig({ userConfigDir: userConfigDir() });
  return config;
}

/** The history/session SQLite db path in effect (config → default data dir). */
function sessionDbPath(config: NexusConfig): string {
  return config.history.dbPath ?? nexusPaths().historyDb;
}

/** Open the session store over the effective db, or report a clean failure. */
async function openStore(config: NexusConfig, io: Io): Promise<SessionStore | null> {
  const dbPath = sessionDbPath(config);
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    io.err(`no session history yet (${dbPath}) — run a turn first\n`);
    return null;
  }
  try {
    return await SessionStore.open(dbPath);
  } catch (e) {
    io.err(`session store unavailable: ${(e as Error).message}\n`);
    return null;
  }
}

// ── session (list | show | rename | branch | delete | export) ─────────────────

function sessionLabel(m: SessionMeta): string {
  return m.name ? `${m.name} (${m.sessionId})` : m.sessionId;
}

export async function cmdSession(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const store = await openStore(config, io);
  if (!store) return 1;

  try {
    if (sub === "list") {
      const sessions = store.listSessions();
      if (output === "json") {
        io.out(`${JSON.stringify(sessions)}\n`);
        return 0;
      }
      if (sessions.length === 0) {
        io.out("no sessions yet\n");
        return 0;
      }
      for (const m of sessions) {
        const when = new Date(m.updatedAt).toISOString();
        io.out(
          `${when}  ${sessionLabel(m)}  ${m.provider ?? "-"}:${m.model ?? "-"}  ` +
            `turns=${m.turnCount} runs=${m.runCount} $${m.costUsd.toFixed(6)}\n`,
        );
      }
      return 0;
    }

    if (sub === "show") {
      const id = args.positionals[1];
      if (!id) {
        io.err("nexus session show <sessionId>\n");
        return 2;
      }
      const meta = store.getSession(id);
      if (!meta) {
        io.err(`no session "${id}"\n`);
        return 1;
      }
      const runs = store.runsOf(id);
      if (output === "json") {
        io.out(`${JSON.stringify({ session: meta, runs })}\n`);
        return 0;
      }
      io.out(`session ${sessionLabel(meta)}\n`);
      io.out(`  created ${new Date(meta.createdAt).toISOString()}\n`);
      io.out(`  provider ${meta.provider ?? "-"}:${meta.model ?? "-"}\n`);
      io.out(
        `  turns=${meta.turnCount} runs=${meta.runCount} events=${meta.eventCount} ` +
          `in=${meta.inputTokens} out=${meta.outputTokens} $${meta.costUsd.toFixed(6)}\n`,
      );
      for (const r of runs) {
        io.out(`  run ${r.run_id.slice(0, 12)} ${r.adapter_id}:${r.model} ${r.status}\n`);
      }
      return 0;
    }

    if (sub === "rename") {
      const id = args.positionals[1];
      const name = args.positionals.slice(2).join(" ").trim();
      if (!id || !name) {
        io.err("nexus session rename <sessionId> <name>\n");
        return 2;
      }
      if (!store.getSession(id)) {
        io.err(`no session "${id}"\n`);
        return 1;
      }
      store.rename(id, name);
      io.out(`renamed ${id} → "${name}"\n`);
      return 0;
    }

    if (sub === "branch") {
      const id = args.positionals[1];
      if (!id) {
        io.err("nexus session branch <sessionId> [--name <name>]\n");
        return 2;
      }
      if (!store.getSession(id)) {
        io.err(`no session "${id}"\n`);
        return 1;
      }
      const name = args.flags.get("name") ?? args.positionals.slice(2).join(" ").trim();
      const newId = store.branch(id, name ? { name } : {});
      io.out(`branched ${id} → ${newId}${name ? ` ("${name}")` : ""}\n`);
      return 0;
    }

    if (sub === "delete" || sub === "rm") {
      const id = args.positionals[1];
      if (!id) {
        io.err("nexus session delete <sessionId>\n");
        return 2;
      }
      if (!store.getSession(id)) {
        io.err(`no session "${id}"\n`);
        return 1;
      }
      store.delete(id);
      io.out(`deleted ${id}\n`);
      return 0;
    }

    if (sub === "export") {
      const id = args.positionals[1];
      if (!id) {
        io.err("nexus session export <sessionId> [--format json|md|html] [-o file]\n");
        return 2;
      }
      const format = parseExportFormat(args.flags.get("format") ?? args.flags.get("mode"));
      const rendered = store.export(id, format);
      if (rendered === null) {
        io.err(`no session "${id}"\n`);
        return 1;
      }
      const outFile = args.flags.get("output");
      if (outFile && outFile !== "text" && outFile !== "json" && outFile !== "ndjson") {
        const path = isAbsolute(outFile) ? outFile : resolve(process.cwd(), outFile);
        writeFileSync(path, rendered, "utf8");
        try {
          chmodSync(path, 0o600);
        } catch {
          /* best-effort on platforms without POSIX perms */
        }
        io.out(`${path}\n`);
        return 0;
      }
      io.out(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
      return 0;
    }

    io.err(`nexus session: unknown subcommand "${sub}" (use: list|show|rename|branch|delete|export)\n`);
    return 2;
  } finally {
    store.close();
  }
}

/** Map `--format`/`--mode` (json|md|markdown|html) to an ExportFormat. */
function parseExportFormat(raw: string | undefined): ExportFormat {
  if (raw === "html") return "html";
  if (raw === "md" || raw === "markdown") return "markdown";
  return "json";
}

// ── replay (re-render a session's UiEvent timeline) ───────────────────────────

/** Render one replayed UiEvent as a CLI text line (mirrors the live renderer). */
function replayLine(ev: UiEvent): string | null {
  switch (ev.t) {
    case "session":
      return `— session ${ev.provider}/${ev.model}`;
    case "text":
      return ev.delta.length > 0 ? ev.delta : null;
    case "tool_call":
      return `\n[tool-call] ${ev.name}`;
    case "tool_result":
      return `[tool-result] ${ev.ok ? "ok" : "error"}`;
    case "diff":
      return `\n[file-edit] ${ev.path}`;
    case "error":
      return `\n[error] ${ev.code}: ${ev.message}`;
    case "usage":
      return `\n[usage] in=${ev.inputTokens} out=${ev.outputTokens} $${ev.costUsd.toFixed(6)}`;
    case "done":
      return `\n[done] ${ev.finishReason}`;
    default:
      return null;
  }
}

export async function cmdReplay(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const id = args.positionals[0];
  if (!id) {
    io.err("nexus replay <sessionId>\n");
    return 2;
  }
  const config = await loadEffectiveConfig();
  const store = await openStore(config, io);
  if (!store) return 1;
  try {
    const bundle = store.loadBundle(id);
    if (!bundle) {
      io.err(`no session "${id}"\n`);
      return 1;
    }
    if (output === "json") {
      io.out(`${JSON.stringify(bundle.timeline)}\n`);
      return 0;
    }
    if (output === "ndjson") {
      // Feed a TUI / downstream consumer the exact UiEvent stream, one per line.
      for (const ev of bundle.timeline) io.out(`${JSON.stringify(ev)}\n`);
      return 0;
    }
    io.err(`replaying session ${sessionLabel(bundle.meta)} (${bundle.timeline.length} events)\n`);
    for (const ev of bundle.timeline) {
      const line = replayLine(ev);
      if (line !== null) io.out(line.startsWith("\n") ? `${line}\n` : line);
    }
    io.out("\n");
    return 0;
  } finally {
    store.close();
  }
}

// ── receipt (the flagship, private-by-default, redaction-safe Code Receipt) ────

export async function cmdReceipt(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    io.err("nexus receipt <sessionId> [-o file.html] [--value <prompt>]\n");
    return 2;
  }
  const config = await loadEffectiveConfig();
  const store = await openStore(config, io);
  if (!store) return 1;
  try {
    if (!store.getSession(id)) {
      io.err(`no session "${id}"\n`);
      return 1;
    }
    // `-o` targets an explicit output file (dir + name split for writeReceipt).
    const outFile = args.flags.get("output");
    const opts: {
      outDir?: string;
      fileName?: string;
      prompt?: string;
      title?: string;
    } = {};
    if (outFile && outFile !== "text" && outFile !== "json" && outFile !== "ndjson") {
      const abs = isAbsolute(outFile) ? outFile : resolve(process.cwd(), outFile);
      const slash = abs.lastIndexOf("/");
      opts.outDir = slash >= 0 ? abs.slice(0, slash) : process.cwd();
      opts.fileName = slash >= 0 ? abs.slice(slash + 1) : abs;
    }
    const prompt = args.flags.get("prompt");
    if (prompt !== undefined) opts.prompt = prompt;
    const title = args.flags.get("title") ?? args.flags.get("system");
    if (title !== undefined) opts.title = title;

    const result = store.generateReceipt(id, opts);
    if (!result) {
      io.err(`no session "${id}"\n`);
      return 1;
    }
    // Private-by-default: print ONLY the local path. Never uploaded or shared.
    io.out(`${result.path}\n`);
    return 0;
  } finally {
    store.close();
  }
}

// ── trace (observability span timeline for a run/session) ─────────────────────

/** Collect the turn ids (== trace ids) a session recorded, for trace filtering. */
function traceIdsForSession(store: SessionStore, sessionId: string): Set<string> {
  const ids = new Set<string>();
  for (const ev of store.eventsOf(sessionId)) ids.add(ev.turn_id);
  return ids;
}

export async function cmdTrace(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const obs = buildObservability(config);

  if (!existsSync(obs.filePath)) {
    io.err(`no trace data yet (${obs.filePath}) — run a turn with observability enabled\n`);
    return 1;
  }
  const spans = loadTraceSpans(obs.filePath);
  if (spans.length === 0) {
    io.err("no spans recorded\n");
    return 1;
  }

  // Optional filter: a traceId, a runId (via span attribute), or a sessionId
  // (resolved to its turn/trace ids through the session store).
  const filter = args.positionals[0];
  let selected = spans;
  if (filter) {
    const direct = spans.filter((s) => s.traceId === filter);
    if (direct.length > 0) {
      selected = direct;
    } else {
      const byRun = spans.filter((s) => s.attributes["nexus.run_id"] === filter);
      if (byRun.length > 0) {
        selected = byRun;
      } else {
        // Treat it as a session id: map to its trace ids.
        const store = await openStore(config, io);
        if (store) {
          try {
            const traceIds = traceIdsForSession(store, filter);
            selected = spans.filter((s) => traceIds.has(s.traceId));
          } finally {
            store.close();
          }
        }
        if (selected.length === 0) {
          io.err(`no spans for "${filter}"\n`);
          return 1;
        }
      }
    }
  }

  if (output === "json") {
    io.out(`${JSON.stringify(selected)}\n`);
    return 0;
  }

  // Group by trace and render each as a Gantt-style timeline.
  const traceStore = new TraceStore();
  traceStore.addAll(selected);
  const traceIds = traceStore.traceIds();
  for (let i = 0; i < traceIds.length; i++) {
    const tid = traceIds[i] as string;
    const rows = traceStore.timeline(tid);
    io.out(`trace ${tid} — ${rows.length} span(s)\n`);
    io.out(`${renderTimeline(rows)}\n`);
    if (i < traceIds.length - 1) io.out("\n");
  }
  return 0;
}

// ── git flows (commit | review | explain | pr) ────────────────────────────────

/** Resolve a provider adapter + model for a git flow (mock-friendly default). */
async function resolveGitProvider(
  args: ParsedArgs,
  config: NexusConfig,
  io: Io,
): Promise<{ adapter: ProviderAdapter; model: string } | null> {
  const runtime = await buildRuntime(config);
  const providerId = args.flags.get("provider") ?? config.defaultProvider;
  const registry: ProviderRegistry = runtime.registry;
  if (!registry.has(providerId)) {
    io.err(`provider "${providerId}" is not available (try -p mock)\n`);
    return null;
  }
  const adapter = registry.get(providerId);
  const model = args.flags.get("model") ?? config.defaultModel ?? firstModel(registry, providerId) ?? "mock-fast";
  return { adapter, model };
}

function firstModel(registry: ProviderRegistry, providerId: string): string | undefined {
  try {
    return registry.capabilitiesOf(providerId).models[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the diff a git flow operates on: piped stdin wins (`git diff | nexus
 * review`); otherwise gather it from the repo (staged first, then the working
 * tree). Returns null (after messaging) when there is nothing to work with.
 */
async function resolveDiff(
  cwd: string,
  io: Io,
  command: string,
): Promise<string | null> {
  const piped = (await readStdin()).trim();
  if (piped.length > 0) return piped;

  if (!(await isGitRepo({ cwd }))) {
    io.err(`nexus ${command}: not a git repo (${cwd}) — or pipe a diff in\n`);
    return null;
  }
  const staged = await gitDiff({ cwd, staged: true });
  if (staged.trim().length > 0) return staged;
  const working = await gitDiff({ cwd });
  if (working.trim().length > 0) return working;
  io.err(`nexus ${command}: no changes to ${command} (working tree clean)\n`);
  return null;
}

function cwdOf(args: ParsedArgs): string {
  const raw = args.flags.get("cwd") ?? process.cwd();
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export async function cmdCommit(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const cwd = cwdOf(args);
  const resolved = await resolveGitProvider(args, config, io);
  if (!resolved) return 1;

  // Commit message is generated from the STAGED diff (what will be committed).
  const piped = (await readStdin()).trim();
  let diffText = piped;
  if (diffText.length === 0) {
    if (!(await isGitRepo({ cwd }))) {
      io.err(`nexus commit: not a git repo (${cwd})\n`);
      return 1;
    }
    diffText = (await gitDiff({ cwd, staged: true })).trim();
    if (diffText.length === 0) diffText = (await gitDiff({ cwd })).trim();
  }
  if (diffText.length === 0) {
    io.err("nexus commit: nothing staged to commit\n");
    return 1;
  }

  const msg = await generateCommitMessage(resolved.adapter, diffText, { model: resolved.model });

  if (output === "json") {
    io.out(`${JSON.stringify(msg)}\n`);
  } else {
    io.out(`${msg.message}\n`);
  }

  // `--approve`/`--yolo` applies the commit (only staged changes are committed).
  if (args.bools.has("approve") || args.bools.has("yolo")) {
    const gitArgs = ["commit", "-m", msg.header];
    if (msg.body) gitArgs.push("-m", msg.body);
    const res = await runGit(gitArgs, { cwd });
    if (!res.ok) {
      io.err(`nexus commit: git commit failed — ${res.stderr.trim() || "no staged changes?"}\n`);
      return 1;
    }
    io.err(`[commit] applied\n`);
  }
  return 0;
}

export async function cmdReview(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const cwd = cwdOf(args);
  const resolved = await resolveGitProvider(args, config, io);
  if (!resolved) return 1;

  const diffText = await resolveDiff(cwd, io, "review");
  if (diffText === null) return 1;

  const review: ReviewResult = await reviewChanges(resolved.adapter, diffText, { model: resolved.model });
  if (output === "json") {
    io.out(`${JSON.stringify({ summary: review.summary, comments: review.comments })}\n`);
    return 0;
  }
  if (review.summary) io.out(`${review.summary}\n`);
  for (const c of review.comments) {
    const loc = c.file ? ` ${c.file}${c.line ? `:${c.line}` : ""}` : "";
    io.out(`[${c.severity}]${loc} ${c.message}\n`);
  }
  return review.comments.some((c) => c.severity === "error") ? 1 : 0;
}

export async function cmdExplain(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const cwd = cwdOf(args);
  const resolved = await resolveGitProvider(args, config, io);
  if (!resolved) return 1;

  const diffText = await resolveDiff(cwd, io, "explain");
  if (diffText === null) return 1;

  const explanation = await explainDiff(resolved.adapter, diffText, { model: resolved.model });
  if (output === "json") {
    io.out(`${JSON.stringify({ explanation })}\n`);
  } else {
    io.out(`${explanation}\n`);
  }
  return 0;
}

export async function cmdPr(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const cwd = cwdOf(args);
  const resolved = await resolveGitProvider(args, config, io);
  if (!resolved) return 1;

  const piped = (await readStdin()).trim();
  const input: { commits?: string; diff?: string } = {};
  if (piped.length > 0) {
    input.diff = piped;
  } else {
    if (!(await isGitRepo({ cwd }))) {
      io.err(`nexus pr: not a git repo (${cwd}) — or pipe a diff in\n`);
      return 1;
    }
    // Compare the current branch against an optional base ref (--base), else
    // summarize the recent history + working diff. A bad/absent ref degrades to
    // empty rather than crashing the command.
    const base = args.flags.get("base");
    const commits = await gitLog({
      cwd,
      maxCount: 20,
      ...(base ? { ref: `${base}..HEAD` } : {}),
    }).catch(() => []);
    if (commits.length > 0) input.commits = commits.map((c) => `- ${c.subject} (${c.hash.slice(0, 8)})`).join("\n");
    const st = await gitStatus({ cwd });
    const branchDiff = base
      ? await gitDiff({ cwd, ref: `${base}...HEAD` }).catch(() => "")
      : st.clean
        ? await gitDiff({ cwd, ref: "HEAD~1" }).catch(() => "")
        : await gitDiff({ cwd });
    if (branchDiff.trim().length > 0) input.diff = branchDiff;
  }

  if (!input.commits && !input.diff) {
    io.err("nexus pr: no commits or diff to describe (pipe a diff or pass --base <ref>)\n");
    return 1;
  }

  const pr = await generatePrDescription(resolved.adapter, input, { model: resolved.model });
  if (output === "json") {
    io.out(`${JSON.stringify({ title: pr.title, body: pr.body })}\n`);
  } else {
    io.out(`${pr.title}\n\n${pr.body}\n`);
  }
  return 0;
}
