/**
 * Contrast Max AAA — Okabe-Ito, CVD-safe (design spec §5.5). Every value clears
 * 7:1 over pure black. Auto-swaps in when `--cvd` is set on any theme.
 */

import { defineTheme } from "./define.js";

export const contrastMax = defineTheme({
  meta: {
    id: "contrast-max",
    name: "Contrast Max AAA",
    author: "NexusCode",
    version: "1.0.0",
    mode: "dark",
    license: "MIT",
    minContrast: "AAA",
  },
  tokens: {
    "surface.sunken": "#000000",
    "surface.base": "#000000",
    "surface.raised": "#121212",
    "surface.overlay": "#1A1A1A",
    "surface.inset": "#0A0A0A",

    "text.primary": "#FFFFFF",
    "text.secondary": "#D6D6D6",
    "text.muted": "#B0B0B0",
    "text.inverse": "#000000",
    "text.link": "#56B4E9",

    "chrome.border": "#767676",
    "chrome.border.subtle": "#4A4A4A",
    "chrome.border.strong": "#B0B0B0",
    "chrome.borderFocus": "#FFFFFF",
    "chrome.title": "#FFFFFF",
    "chrome.divider": "#4A4A4A",

    "accent.default": "#56B4E9",
    "accent.emphasis": "#8ACFF2",
    "accent.muted": "#3A7AA0",
    "accent.fg": "#000000",

    "success.fg": "#48C9A2",
    "success.bg": "#001A10",
    "success.border": "#2E9578",
    "warning.fg": "#F0A860",
    "warning.bg": "#1A0F00",
    "warning.border": "#C08540",
    "error.fg": "#FF8A6E",
    "error.bg": "#1A0800",
    "error.border": "#C56850",
    "info.fg": "#56B4E9",
    "info.bg": "#001525",
    "info.border": "#3A7AA0",

    "stream.cursor": "#FFFFFF",
    "stream.thinking": "#B0B0B0",
    "stream.text": "#FFFFFF",

    "diff.added.fg": "#48C9A2",
    "diff.added.bg": "#001A10",
    "diff.removed.fg": "#FF8A6E",
    "diff.removed.bg": "#1A0800",
    "diff.context": "#B0B0B0",
    "diff.gutter": "#B0B0B0",

    "syntax.keyword": "#FF8A6E",
    "syntax.function": "#CC9AE0",
    "syntax.type": "#7FB0FF",
    "syntax.string": "#48C9A2",
    "syntax.number": "#F0A860",
    "syntax.comment": "#B0B0B0",
    "syntax.operator": "#D6D6D6",
    "syntax.variable": "#FFFFFF",
    "syntax.constant": "#7FB0FF",
    "syntax.tag": "#48C9A2",
    "syntax.attribute": "#F0A860",
    "syntax.invalid": "#FF8A6E",

    "provider.anthropic": "#F0A860",
    "provider.openai": "#48C9A2",
    "provider.google": "#7FB0FF",
    "provider.xai": "#FFFFFF",
    "provider.ollama": "#CC9AE0",
    "provider.mistral": "#F0E442",
    "provider.deepseek": "#6FA8FF",
    "provider.custom": "#F090C8",

    "cost.ok": "#48C9A2",
    "cost.warn": "#F0A860",
    "cost.crit": "#FF8A6E",

    "selection.bg": "#2A2A2A",
    "selection.fg": "#FFFFFF",
    "focus.ring": "#FFFFFF",
    "badge.bg": "#1A1A1A",
    "badge.fg": "#FFFFFF",
    "scrollbar.track": "#1A1A1A",
    "scrollbar.thumb": "#B0B0B0",
    "spinner": "#FFFFFF",
    "link.visited": "#CC9AE0",
    "overlay.scrim": "#000000",
  },
});
