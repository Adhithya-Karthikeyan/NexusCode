/**
 * `mountTui` — the boot guard (design spec §2.8, hard rule 4). Detects
 * capabilities, refuses to mount the framed Ink TUI on a non-TTY / `TERM=dumb` /
 * too-narrow terminal, and prints a graceful one-line fallback instead of
 * crashing. On a capable terminal it renders `<TuiApp>` via Ink.
 */

import { render, type Instance } from "ink";
import { createElement } from "react";
import {
  canMountTui,
  detectCapabilities,
  type Capabilities,
  type StreamLike,
} from "../caps/capabilities.js";
import { TuiApp, type TuiAppProps } from "./TuiApp.js";

export interface MountResult {
  mounted: boolean;
  reason?: "non-tty" | "term-dumb" | "too-narrow";
  /** The Ink instance when mounted (for `waitUntilExit`/`unmount`). */
  instance?: Instance;
}

export interface MountOptions extends TuiAppProps {
  /** Output stream (defaults to `process.stdout`). */
  stdout?: NodeJS.WriteStream;
  /** Env for capability detection (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Pre-resolved capabilities (skips detection). */
  capabilities?: Capabilities;
}

/**
 * Mount the TUI, or print a fallback and return `{ mounted: false }`. Never
 * throws for an incapable terminal — a pure renderer must always produce output.
 */
export function mountTui(options: MountOptions = {}): MountResult {
  const { stdout = process.stdout, env = process.env, capabilities, caps, ...appProps } = options;
  const detected = capabilities ?? detectCapabilities(env, stdout as unknown as StreamLike);
  const effective: Capabilities = caps ? { ...detected, ...caps } : detected;

  const decision = canMountTui(effective, env);
  if (!decision.ok) {
    stdout.write(`${decision.fallback ?? "TUI unavailable — linear mode."}\n`);
    return decision.reason ? { mounted: false, reason: decision.reason } : { mounted: false };
  }

  const instance = render(createElement(TuiApp, { caps: effective, ...appProps }), { stdout });
  return { mounted: true, instance };
}
