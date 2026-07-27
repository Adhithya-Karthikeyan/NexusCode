/**
 * `runTui(engine, opts)` — the engine bridge (task B). It opens a session on the
 * real `@nexuscode/core` engine, mounts the interactive `<App>` over a live
 * `EventStore`, and on every user submit dispatches a turn so a **real** run
 * streams into the panes (text, tool activity, usage/cost) as `UiEvent`s.
 *
 * The bridge is a pure adapter: the engine stays the single source of truth
 * (§10.4-1). It never invents state — it only projects `Labeled<StreamChunk>`
 * into `UiEvent`s (via {@link projectLabeled}) and appends them to the store the
 * renderer reads. Non-TTY / `TERM=dumb` / too-narrow terminals never mount the
 * framed TUI; the boot guard prints a one-line fallback instead of crashing.
 */

import { render, type Instance } from "ink";
import { createElement } from "react";
import { randomUUID } from "node:crypto";
import {
  dispatch,
  userText,
  type Engine,
  type Message,
  type OrchestrationHandle,
  type OrchestrationOutcome,
  type RunContext,
  type RunSpec,
  type Session,
} from "@nexuscode/core";
import { App, type AppProps } from "../app/App.js";
import {
  canMountTui,
  detectCapabilities,
  type Capabilities,
  type StreamLike,
} from "../caps/capabilities.js";
import type { UiMode } from "../chrome/mode.js";
import type { PresetId } from "../layout/tree.js";
import { createEventStore, type EventStore } from "../store/store.js";
import { projectLabeled } from "./project.js";

/**
 * How one submitted turn becomes an `OrchestrationHandle`. The default is a
 * single-provider dispatch; the CLI can supply a factory that switches to the
 * agentic tool-loop (`dispatchAgent`) for AGENT/AUTOPILOT modes, keeping the tui
 * package decoupled from `@nexuscode/tools`.
 */
export type TurnDispatcher = (
  input: Message[],
  ctx: RunContext,
  mode: UiMode,
) => OrchestrationHandle;

/** Atomic provider/model selection returned by the host after preflight. */
export type ProviderSelectionResult =
  | {
      accepted: true;
      provider: string;
      model: string;
      contextMax?: number;
      reasoningSupported?: boolean;
      receipt?: string;
    }
  | { accepted: false; provider: string; reason: string };

export interface RunTuiOptions {
  /** Provider id for the single-dispatch default (and the lane key). */
  provider: string;
  /** Model id for the single-dispatch default. */
  model: string;
  /** System prompt applied to the default dispatch. */
  system?: string;
  /** Session title shown in the identity strip. */
  sessionName?: string;
  /** Real context window for the HUD gauge (engine-owned). */
  contextMax?: number;
  /** Initial theme id (`--theme`). Defaults to Nexus Noir. */
  themeId?: string;
  /** Initial layout preset. Defaults to `chat`. */
  preset?: PresetId;
  /** Seed input history. */
  history?: readonly string[];
  /** Custom per-turn dispatch (e.g. the agent tool-loop). */
  dispatchTurn?: TurnDispatcher;
  /** Output stream (defaults to `process.stdout`). */
  stdout?: NodeJS.WriteStream;
  /** Env for capability detection (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Pre-resolved capabilities (tests / forced modes). */
  capabilities?: Capabilities;

  // --- Slash-command registry data (populates the interactive pickers). ---
  /** Every provider→model pair from the registry (the `/model` picker). */
  models?: readonly { provider: string; model: string; hint?: string }[];
  /** Installed providers (the `/provider` picker). */
  providers?: readonly { id: string; hint?: string }[];
  /** Registered tools (the `/tools` list). */
  tools?: readonly { name: string; description?: string }[];
  /** Configured MCP servers (the `/mcp` list). */
  mcpServers?: readonly { name: string; hint?: string }[];
  /**
   * Live model discovery for ONE provider — the `/model` picker queries the
   * ACTIVE provider's REAL model list through this (an `adapter.listModels()`
   * runtime helper) so it never shows the global cross-provider catalog. Falls
   * back to the static `models` pool when absent or when it returns nothing.
   */
  listModelsFor?: (providerId: string) => Promise<readonly { model: string; hint?: string }[]>;
  /**
   * Live `/model` switch — re-point the per-turn dispatch at the picked model.
   * `transcript` is the session's short-term conversation memory AS IT STANDS
   * right now (read-only) — the host needs it to assess whether the target
   * can actually accept what the conversation already contains (e.g. tool
   * calls/results), the same way an explicit `chat --persistent` switch does.
   * There is no new turn yet at preflight time, so this is the transcript
   * itself, not a `ChatRequest` built around one.
   */
  onModelChange?: (
    model: string,
    provider: string,
    transcript: readonly Message[],
  ) => ProviderSelectionResult | void;
  /** Live `/provider` switch. See `onModelChange`'s `transcript` doc. */
  onProviderChange?: (
    provider: string,
    transcript: readonly Message[],
  ) => ProviderSelectionResult | void;
  /** Live `/effort` switch — apply the picked reasoning effort to the next turn. */
  onEffortChange?: (effort: string) => void;
  /** Whether the active provider supports reasoning (drives the `/effort` picker). */
  reasoningSupported?: boolean;
}

export interface RunTuiResult {
  mounted: boolean;
  reason?: "non-tty" | "term-dumb" | "too-narrow";
  instance?: Instance;
  /** Resolves when the user exits the TUI (Ink `waitUntilExit`). */
  waitUntilExit?: () => Promise<void>;
}

/** Build a single-provider `OrchestrationHandle` for one turn (the default path). */
export function singleDispatch(
  provider: string,
  model: string,
  input: Message[],
  ctx: RunContext,
  system?: string,
): OrchestrationHandle {
  const run: RunSpec = { adapterId: provider, model, input, idempotencyKey: randomUUID() };
  if (system !== undefined) run.params = { system };
  return dispatch({ kind: "single", run }, ctx);
}

/**
 * Pump one handle's labeled chunk stream into the store as `UiEvent`s, then
 * settle. Pure adapter: it appends projected events and never mutates the engine.
 */
export async function streamTurnIntoStore(
  handle: OrchestrationHandle,
  store: EventStore,
  opts: { adapterIds: readonly string[]; single: boolean },
): Promise<OrchestrationOutcome> {
  for await (const labeled of handle.events()) {
    const events = projectLabeled(labeled, opts.adapterIds, opts.single);
    if (events.length > 0) store.append(...events);
  }
  return handle.outcome();
}

/**
 * Run one submitted turn end-to-end: open a turn on the session, dispatch it, and
 * stream every projected `UiEvent` into the store. Exposed for headless tests
 * (drive it with a real mock engine and assert the store/HUD).
 */
export async function runTurn(
  session: Session,
  store: EventStore,
  opts: {
    provider: string;
    model: string;
    text: string;
    system?: string;
    mode?: UiMode;
    dispatchTurn?: TurnDispatcher;
    /**
     * Prior conversation transcript (short-term memory). The turn is dispatched
     * with the FULL history + the new user line so the model remembers earlier
     * messages; without it every turn is an isolated single message (amnesia).
     */
    history?: readonly Message[];
  },
): Promise<OrchestrationOutcome> {
  const prior = opts.history ?? [];
  const turn = session.newTurn({ messages: [...prior, ...userText(opts.text)] });
  const ctx = turn.context();
  const mode = opts.mode ?? "CHAT";
  const handle = opts.dispatchTurn
    ? opts.dispatchTurn(turn.input, ctx, mode)
    : singleDispatch(opts.provider, opts.model, turn.input, ctx, opts.system);
  const outcome = await streamTurnIntoStore(handle, store, {
    adapterIds: [opts.provider],
    single: true,
  });
  // On failure this also rolls back the unanswered user message from engine
  // history, so switching providers cannot produce an invalid `user,user`
  // transcript on the next request.
  turn.record(outcome);
  return outcome;
}

/**
 * Fold one settled turn into the short-term transcript the NEXT turn is
 * dispatched with.
 *
 * A failed turn used to contribute NOTHING — not even the user's own message —
 * so the question that failed vanished from history. That is the worst possible
 * moment to forget it: a provider failing is the single most common reason a
 * user reaches for `/provider`, and after the switch the replacement provider
 * had no idea what was asked. The user line is now always kept.
 *
 * The reason it was dropped is real, though: leaving a bare unanswered user
 * message makes the next request read `user, user`, which providers with strict
 * role alternation reject. So a failed turn records a short synthetic assistant
 * note in the reply slot instead — alternation stays valid AND the replacement
 * provider can see that the previous attempt failed and why.
 */
export function recordTurnIntoTranscript(
  transcript: Message[],
  userMsgs: readonly Message[],
  outcome: OrchestrationOutcome,
): void {
  const result = outcome.winner ?? outcome.runs[0];
  transcript.push(...userMsgs);
  if (result?.status === "ok" && result.text.length > 0) {
    transcript.push({ role: "assistant", content: [{ type: "text", text: result.text }] });
    return;
  }
  const reason = result?.error?.message ?? result?.error?.code ?? "no response";
  const provider = result?.adapterId ?? "the provider";
  transcript.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: `(no answer — ${provider} failed: ${reason}. The question above is still unanswered.)`,
      },
    ],
  });
}

/**
 * Mount the interactive TUI over a real engine, or print a fallback and return
 * `{ mounted: false }`. Never throws for an incapable terminal (hard rule 4).
 */
export async function runTui(engine: Engine, opts: RunTuiOptions): Promise<RunTuiResult> {
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const caps = opts.capabilities ?? detectCapabilities(env, stdout as unknown as StreamLike);

  const decision = canMountTui(caps, env);
  if (!decision.ok) {
    stdout.write(`${decision.fallback ?? "TUI unavailable — linear mode."}\n`);
    return decision.reason ? { mounted: false, reason: decision.reason } : { mounted: false };
  }

  const store = createEventStore();
  const session = await engine.openSession();

  // Short-term conversation memory: every turn is dispatched with the FULL prior
  // transcript, and each turn's user line + the assistant's reply are recorded
  // back so the NEXT turn has context. This is what makes the harness remember
  // the conversation instead of treating each message as an isolated prompt.
  const transcript: Message[] = [];

  // The provider/model in effect RIGHT NOW. `opts.provider`/`opts.model` are only
  // the launch values; a `/model` or `/provider` switch must move these too, or
  // the default single-dispatch path keeps calling the model the user switched
  // away from and the lane keys stay stamped with the old adapter id.
  let liveProvider = opts.provider;
  let liveModel = opts.model;
  const trackSwitch = (selection: ProviderSelectionResult | void): ProviderSelectionResult | void => {
    if (selection?.accepted === true) {
      liveProvider = selection.provider;
      liveModel = selection.model;
    }
    return selection;
  };

  let running = false;
  const onSubmit = (text: string, mode: UiMode): void => {
    if (running) return; // one turn at a time; the engine owns concurrency policy
    running = true;
    const userMsgs = userText(text);
    void runTurn(session, store, {
      provider: liveProvider,
      model: liveModel,
      text,
      mode,
      history: transcript,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(opts.dispatchTurn ? { dispatchTurn: opts.dispatchTurn } : {}),
    })
      .then((outcome) => {
        recordTurnIntoTranscript(transcript, userMsgs, outcome);
      })
      .catch((e: unknown) => {
        store.append({
          t: "error",
          lane: "main",
          code: "dispatch_failed",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        });
      })
      .finally(() => {
        running = false;
      });
  };

  const appProps: AppProps = {
    store,
    caps,
    onSubmit,
    activeModel: opts.model,
    activeProvider: opts.provider,
    traceTarget: session.id,
    ...(opts.sessionName !== undefined ? { sessionName: opts.sessionName } : {}),
    ...(opts.contextMax !== undefined ? { contextMax: opts.contextMax } : {}),
    ...(opts.themeId !== undefined ? { initialThemeId: opts.themeId } : {}),
    ...(opts.preset !== undefined ? { initialPreset: opts.preset } : {}),
    ...(opts.history !== undefined ? { history: opts.history } : {}),
    ...(opts.models !== undefined ? { models: opts.models } : {}),
    ...(opts.providers !== undefined ? { providers: opts.providers } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.listModelsFor !== undefined ? { listModelsFor: opts.listModelsFor } : {}),
    ...(opts.onModelChange !== undefined
      ? { onModelChange: (m: string, p: string) => trackSwitch(opts.onModelChange!(m, p, transcript)) }
      : {}),
    ...(opts.onProviderChange !== undefined
      ? { onProviderChange: (p: string) => trackSwitch(opts.onProviderChange!(p, transcript)) }
      : {}),
    ...(opts.onEffortChange !== undefined ? { onEffortChange: opts.onEffortChange } : {}),
    ...(opts.reasoningSupported !== undefined ? { reasoningSupported: opts.reasoningSupported } : {}),
  };

  // Ink's built-in Ctrl+C handler sets raw mode on stdin; on a non-TTY stdin
  // (the `NEXUS_FORCE_TUI` escape hatch / test rigs) that throws. Disable it there
  // so a forced mount degrades gracefully instead of crashing; our own interrupt
  // ladder (InputBox `onInterrupt`) still handles Ctrl+C on a real terminal.
  const exitOnCtrlC = process.stdin.isTTY === true;
  const instance = render(createElement(App, appProps), { stdout, exitOnCtrlC });
  return {
    mounted: true,
    instance,
    waitUntilExit: () => instance.waitUntilExit(),
  };
}
