/**
 * `<TuiApp>` — the provider stack + `<Workspace>` root. This is the mountable
 * unit: `CapabilityProvider` (resolves the terminal once) wraps `ThemeProvider`
 * (binds the active theme to a capability-gated resolver) wraps the pure-renderer
 * `<Workspace>`. Tests render this directly with explicit `caps`/`viewport`.
 */

import type { NexusTheme } from "@nexuscode/theme";
import { CapabilityProvider } from "../caps/CapabilityProvider.js";
import type { Capabilities } from "../caps/capabilities.js";
import { Workspace, type WorkspaceProps } from "../layout/Workspace.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

export interface TuiAppProps extends WorkspaceProps {
  /** Active theme (defaults to Nexus Noir). */
  theme?: NexusTheme;
  /** Capability override (tests / forced modes). */
  caps?: Partial<Capabilities>;
}

export function TuiApp({ theme, caps, ...workspace }: TuiAppProps): React.JSX.Element {
  return (
    <CapabilityProvider {...(caps ? { caps } : {})}>
      <ThemeProvider {...(theme ? { theme } : {})}>
        <Workspace {...workspace} />
      </ThemeProvider>
    </CapabilityProvider>
  );
}
