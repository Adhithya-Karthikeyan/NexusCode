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
  /** Live `/model` switch — re-point the per-turn dispatch at the picked model. */
  onModelChange?: (model: string, provider: string) => void;
  /** Live `/provider` switch. */
  onProviderChange?: (provider: string) => void;
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
  return streamTurnIntoStore(handle, store, { adapterIds: [opts.provider], single: true });
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

  let running = false;
  const onSubmit = (text: string, mode: UiMode): void => {
    if (running) return; // one turn at a time; the engine owns concurrency policy
    running = true;
    const userMsgs = userText(text);
    void runTurn(session, store, {
      provider: opts.provider,
      model: opts.model,
      text,
      mode,
      history: transcript,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(opts.dispatchTurn ? { dispatchTurn: opts.dispatchTurn } : {}),
    })
      .then((outcome) => {
        // Persist this turn into the transcript (user line + assistant reply) so
        // the next turn remembers it. `text` is the model's final answer for the
        // turn (after any tool loop). A failed/empty turn contributes no reply.
        const result = outcome.winner ?? outcome.runs[0];
        transcript.push(...userMsgs);
        if (result && result.text.length > 0) {
          transcript.push({ role: "assistant", content: [{ type: "text", text: result.text }] });
        }
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
    ...(opts.onModelChange !== undefined ? { onModelChange: opts.onModelChange } : {}),
    ...(opts.onProviderChange !== undefined ? { onProviderChange: opts.onProviderChange } : {}),
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
