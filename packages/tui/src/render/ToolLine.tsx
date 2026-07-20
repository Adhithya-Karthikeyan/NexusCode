/**
 * `<ToolLine>` — a compact, inline tool-call row for the conversation-first view
 * (Claude-Code style). One line per invocation: `  ↳ Read src/auth.ts  ✓`, or
 * `  ↳ $ npm test  ✓ 42 passed`. Status is carried by a **glyph + color + word**
 * so it survives no-color / CVD (§1.3.2 — color is never load-bearing). Pure
 * renderer over one {@link ../store/viewState.ToolActivity}.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph, type GlyphName } from "../caps/glyphs.js";
import type { TokenId } from "@nexuscode/theme";
import { useTextStyle } from "../theme/ThemeProvider.js";
import type { ToolActivity } from "../store/viewState.js";

/** Status → glyph + color token + screen-reader word (never color-only). */
const STATUS: Record<ToolActivity["status"], { glyph: GlyphName; token: TokenId; word: string }> = {
  running: { glyph: "running", token: "accent.default", word: "running" },
  ok: { glyph: "ok", token: "success.fg", word: "ok" },
  error: { glyph: "error", token: "error.fg", word: "failed" },
};

/** Pull a short, human label + verb out of a tool name + its args. */
export function summarizeTool(name: string, args: unknown): { verb: string; detail: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const n = name.toLowerCase();
  const path = str(a.path ?? a.file ?? a.filename ?? a.target);
  const cmd = str(a.command ?? a.cmd ?? a.script);

  if (n.includes("read") || n === "cat" || n === "open") return { verb: "Read", detail: path };
  if (n.includes("write") || n.includes("create")) return { verb: "Write", detail: path };
  if (n.includes("edit") || n.includes("patch") || n.includes("apply")) return { verb: "Edit", detail: path };
  if (n.includes("bash") || n.includes("shell") || n.includes("exec") || n.includes("run")) {
    return { verb: "$", detail: cmd || str(a.input) };
  }
  if (n.includes("search") || n.includes("grep") || n.includes("find")) {
    return { verb: "Search", detail: str(a.query ?? a.pattern ?? a.q) };
  }
  if (n.includes("list") || n.includes("ls")) return { verb: "List", detail: path };
  // Fallback: the raw tool id + a compact arg hint.
  const hint = path || cmd || str(a.query ?? a.name) || "";
  return { verb: name, detail: hint };
}

/** Trim an over-long detail to keep the row to one line. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export interface ToolLineProps {
  tool: ToolActivity;
  /** Column budget for the whole row (keeps details on one line). */
  width?: number;
}

export function ToolLine({ tool, width = 80 }: ToolLineProps): React.JSX.Element {
  const caps = useCaps();
  const arrowStyle = useTextStyle("text.muted");
  const verbStyle = useTextStyle("text.secondary");
  const detailStyle = useTextStyle("text.muted");
  const status = STATUS[tool.status];
  const statusStyle = useTextStyle(status.token);

  const { verb, detail } = summarizeTool(tool.name, tool.args);
  const arrow = caps.unicode ? "↳" : "->";
  const detailMax = Math.max(8, width - verb.length - 10);

  // No private indent: the row starts at the caller's left edge so tool lines
  // align with the prose of the turn they belong to (`<MessageView>` places
  // them inside the same content column).
  return (
    <Box width={width} flexShrink={0}>
      <Text {...arrowStyle} wrap="truncate-end">
        {arrow}{" "}
      </Text>
      <Text {...verbStyle} wrap="truncate-end">
        {verb}
      </Text>
      {detail ? (
        <Text {...detailStyle} wrap="truncate-end">
          {" "}
          {clamp(detail, detailMax)}
        </Text>
      ) : null}
      <Text {...statusStyle} wrap="truncate-end">
        {" "}
        {glyph(caps, status.glyph)}
      </Text>
    </Box>
  );
}
