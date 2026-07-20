/**
 * `CapabilityProvider` + `useCaps()` (design spec §3.0). Resolves the terminal
 * capability set once and hands it to the tree via context. Components read caps
 * to choose glyph/ASCII, motion tier, and color depth — never `process.env`
 * directly.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { detectCapabilities, type Capabilities } from "./capabilities.js";

const CapabilityContext = createContext<Capabilities | null>(null);

export interface CapabilityProviderProps {
  /** Explicit override (tests / forced modes). Falls back to auto-detection. */
  caps?: Partial<Capabilities>;
  children: ReactNode;
}

export function CapabilityProvider({ caps, children }: CapabilityProviderProps): React.JSX.Element {
  const value = useMemo<Capabilities>(() => {
    const base = detectCapabilities();
    return caps ? { ...base, ...caps } : base;
  }, [caps]);
  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

/** Read the resolved capability set. Throws if used outside the provider. */
export function useCaps(): Capabilities {
  const ctx = useContext(CapabilityContext);
  if (!ctx) throw new Error("useCaps() must be used within <CapabilityProvider>");
  return ctx;
}
