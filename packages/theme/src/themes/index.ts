/**
 * The built-in theme registry — the 6 signature palettes (design spec §5) plus
 * 10 additional community-inspired dark themes. Nexus Noir is the default;
 * Paper Nexus is its OS-auto light sibling.
 */

import type { NexusTheme } from "../types.js";
import { nexusNoir } from "./nexus-noir.js";
import { paperNexus } from "./paper-nexus.js";
import { solarFlare } from "./solar-flare.js";
import { glacier } from "./glacier.js";
import { contrastMax } from "./contrast-max.js";
import { synthwaveGrid } from "./synthwave-grid.js";
import { neon } from "./neon.js";
import { midnight } from "./midnight.js";
import { vampire } from "./vampire.js";
import { retroAmber } from "./retro-amber.js";
import { pastel } from "./pastel.js";
import { frost } from "./frost.js";
import { matrix } from "./matrix.js";
import { vivid } from "./vivid.js";
import { rose } from "./rose.js";
import { forest } from "./forest.js";

export { nexusNoir, paperNexus, solarFlare, glacier, contrastMax, synthwaveGrid };
export { neon, midnight, vampire, retroAmber, pastel, frost, matrix, vivid, rose, forest };

/** The default theme id (flagship dark). */
export const DEFAULT_THEME_ID = "nexus-noir";

/** All built-in themes, keyed by `meta.id`. */
export const BUILTIN_THEMES: Readonly<Record<string, NexusTheme>> = Object.freeze({
  [nexusNoir.meta.id]: nexusNoir,
  [paperNexus.meta.id]: paperNexus,
  [solarFlare.meta.id]: solarFlare,
  [glacier.meta.id]: glacier,
  [contrastMax.meta.id]: contrastMax,
  [synthwaveGrid.meta.id]: synthwaveGrid,
  [neon.meta.id]: neon,
  [midnight.meta.id]: midnight,
  [vampire.meta.id]: vampire,
  [retroAmber.meta.id]: retroAmber,
  [pastel.meta.id]: pastel,
  [frost.meta.id]: frost,
  [matrix.meta.id]: matrix,
  [vivid.meta.id]: vivid,
  [rose.meta.id]: rose,
  [forest.meta.id]: forest,
});

/** Ordered list of built-in themes (registry/picker order). */
export const BUILTIN_THEME_LIST: readonly NexusTheme[] = [
  nexusNoir,
  paperNexus,
  solarFlare,
  glacier,
  contrastMax,
  synthwaveGrid,
  neon,
  midnight,
  vampire,
  retroAmber,
  pastel,
  frost,
  matrix,
  vivid,
  rose,
  forest,
];
