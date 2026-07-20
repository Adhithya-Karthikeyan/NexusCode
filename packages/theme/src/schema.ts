/**
 * Zod schema for the shareable/marketplace theme file (`.nexustheme`, JSON).
 * Validates structure + color-literal syntax; token completeness is enforced
 * separately by the loader (so `extends` themes can be partial).
 */

import { z } from "zod";
import { BRAND_TOKEN_IDS, TOKEN_ID_SET } from "./tokens.js";

const TEXT_ATTRS = ["bold", "dim", "underline", "reverse", "italic", "strikethrough"] as const;
const ANSI16 = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
] as const;

/** A color literal: `#hex`, `rgb()`, `hsl()`, or `@primitiveRef`. */
export const ColorValueSchema = z
  .string()
  .refine(
    (v) =>
      /^#[0-9a-fA-F]{3}$/.test(v) ||
      /^#[0-9a-fA-F]{6}$/.test(v) ||
      /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i.test(v) ||
      /^hsl\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*\)$/i.test(v) ||
      /^@[\w.-]+$/.test(v),
    { message: "invalid color value (expected #hex, rgb(), hsl(), or @primitiveRef)" },
  );

const MetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  author: z.string().optional(),
  version: z.string().optional(),
  mode: z.enum(["dark", "light"]),
  followsOs: z.boolean().optional(),
  pairId: z.string().optional(),
  extends: z.string().optional(),
  license: z.string().optional(),
  minContrast: z.enum(["AA", "AAA"]).optional(),
});

const AnsiFallbackEntrySchema = z.object({
  ansi: z.enum(ANSI16),
  attrs: z.array(z.enum(TEXT_ATTRS)).optional(),
});

/** Token id key must be one of the 74 known semantic tokens. */
const TokenRecord = z.record(z.string(), ColorValueSchema).superRefine((rec, ctx) => {
  for (const key of Object.keys(rec)) {
    if (!TOKEN_ID_SET.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown token id: ${key}`, path: [key] });
    }
  }
});

const BrandRecord = z.record(z.string(), ColorValueSchema).superRefine((rec, ctx) => {
  const set = new Set<string>(BRAND_TOKEN_IDS);
  for (const key of Object.keys(rec)) {
    if (!set.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown brand token: ${key}`, path: [key] });
    }
  }
});

/** The full theme-file schema. */
export const ThemeFileSchema = z.object({
  meta: MetaSchema,
  primitives: z.record(z.string(), z.string()).default({}),
  tokens: TokenRecord,
  brand: BrandRecord.optional(),
  ansiFallback: z.record(z.string(), AnsiFallbackEntrySchema).optional(),
});

export type ThemeFileInput = z.input<typeof ThemeFileSchema>;
export type ThemeFileParsed = z.infer<typeof ThemeFileSchema>;
