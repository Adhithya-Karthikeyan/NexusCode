/**
 * `<Onboarding>` — the first-run wizard (design spec §8.2). A calm, keyboard-only
 * linear flow: **Welcome → pick theme (live preview) → provider/keys hint → first
 * prompt.** Picking a theme re-skins the running wizard immediately (the parent
 * `<App>` owns the active theme id, so `onPickTheme` is a literal preview, §8.2).
 * Nothing is written until the final step hands the first prompt back to `<App>`.
 *
 * Pure renderer + local navigation state only. Controlled `step`/`highlight` props
 * make it fully headless-testable without raw-mode keystrokes.
 */

import { Box, Text, useInput, useStdin } from "ink";
import { useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { StrandRow } from "../brand/StrandRow.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

export interface OnboardingThemeChoice {
  id: string;
  name: string;
}

export interface OnboardingProps {
  /** Selectable themes (id + display name), in picker order. */
  themes: readonly OnboardingThemeChoice[];
  /** Active theme id (controlled by `<App>` so the preview re-skins live). */
  themeId: string;
  /** Live preview: called on every highlight change. */
  onPickTheme: (id: string) => void;
  /** Finish onboarding; an optional first prompt is submitted immediately. */
  onComplete: (firstPrompt?: string) => void;
  /** Provider availability hint (e.g. "mock ready · add keys with `nexus keys set`"). */
  providerHint?: string;
  /** Seed step (tests / resume). 0=welcome 1=theme 2=providers 3=first-prompt. */
  initialStep?: number;
  /** Fully controlled step (tests); overrides internal navigation. */
  step?: number;
}

const STEPS = ["welcome", "theme", "providers", "prompt"] as const;

export function Onboarding({
  themes,
  themeId,
  onPickTheme,
  onComplete,
  providerHint,
  initialStep = 0,
  step: controlledStep,
}: OnboardingProps): React.JSX.Element {
  const caps = useCaps();
  // `=== true` coercion: on a non-TTY Ink reports `undefined`, which its
  // `useInput` would treat as active (and throw on raw mode). See <App>.
  const { isRawModeSupported } = useStdin();
  const rawMode = isRawModeSupported === true;
  const [internalStep, setInternalStep] = useState(initialStep);
  const step = controlledStep ?? internalStep;

  const node = useTextStyle("accent.default");
  const primary = useTextStyle("text.primary");
  const accent = useTextStyle("accent.default");
  const muted = useTextStyle("text.muted");
  const focus = useTextStyle("focus.ring");

  const themeIndex = Math.max(0, themes.findIndex((t) => t.id === themeId));

  const advance = (): void => {
    if (step >= STEPS.length - 1) onComplete();
    else setInternalStep(step + 1);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onComplete();
        return;
      }
      if (step === 1) {
        if (key.upArrow || key.downArrow) {
          const dir = key.downArrow ? 1 : -1;
          const next = (themeIndex + dir + themes.length) % themes.length;
          onPickTheme(themes[next]!.id);
          return;
        }
      }
      if (key.return || input === " ") advance();
    },
    { isActive: rawMode },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text {...node}>{glyph(caps, "node")} </Text>
        <Text {...primary}>Nexus</Text>
        <Text {...accent}>Code</Text>
        <Text {...muted}> · first run</Text>
      </Box>

      {step === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <StrandRow />
          <Text {...primary}>the universal, terminal-first AI harness</Text>
          <Text {...muted}>Let's set up your workspace. Ready.</Text>
          <Text {...muted}>
            {glyph(caps, "focus")} press Enter to begin · Esc to skip
          </Text>
        </Box>
      ) : null}

      {step === 1 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...primary}>Choose a theme</Text>
          <Text {...muted}>
            {caps.unicode ? "↑↓" : "up/dn"} preview live · Enter select
          </Text>
          {themes.map((t, i) => {
            const on = i === themeIndex;
            return (
              <Text key={t.id} {...(on ? focus : muted)}>
                {on ? glyph(caps, "dotFilled") : glyph(caps, "dotHollow")} {t.name}
                {on ? "  ← preview" : ""}
              </Text>
            );
          })}
        </Box>
      ) : null}

      {step === 2 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...primary}>Providers</Text>
          <Text {...useTextStyle(providerToken("ollama"))}>
            {glyph(caps, "dotFilled")}
            {providerLetter("ollama")} local · no key needed
          </Text>
          <Text {...muted}>{providerHint ?? "mock provider is always ready — zero keys, offline."}</Text>
          <Text {...muted}>{"Add cloud keys anytime: nexus keys set <provider>"}</Text>
          <Text {...muted}>
            {glyph(caps, "focus")} Enter to continue
          </Text>
        </Box>
      ) : null}

      {step === 3 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...primary}>You're ready.</Text>
          <Text {...muted}>Try: "explain this repo" · "/plan add auth" · @file to attach</Text>
          <Text {...accent}>
            {glyph(caps, "node")} {glyph(caps, "prompt")} press Enter to open the workspace
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
