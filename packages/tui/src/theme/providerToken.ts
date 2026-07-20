/**
 * Map an engine provider id to its semantic hue token (design spec §1.2, §5).
 * Every provider is a strand with its own hue; unknown providers fall to the
 * shared `provider.custom` token so a new backend still renders (never crashes).
 */

import { PROVIDER_TOKENS, type TokenId } from "@nexuscode/theme";

const KNOWN = new Set<string>(PROVIDER_TOKENS);

/** Resolve `provider.<id>` when known, else `provider.custom`. */
export function providerToken(provider: string): TokenId {
  const id = `provider.${provider.toLowerCase()}`;
  return (KNOWN.has(id) ? id : "provider.custom") as TokenId;
}

/** Single-letter provider code for no-color attribution (`●A`, §2.3). */
export function providerLetter(provider: string): string {
  const p = provider.toLowerCase();
  if (p.startsWith("anthropic")) return "A";
  if (p.startsWith("openai")) return "O";
  if (p.startsWith("google") || p.startsWith("gemini")) return "G";
  if (p.startsWith("xai") || p.startsWith("grok")) return "X";
  if (p.startsWith("ollama")) return "L";
  if (p.startsWith("mistral")) return "M";
  if (p.startsWith("deepseek")) return "D";
  return (provider[0] ?? "?").toUpperCase();
}
