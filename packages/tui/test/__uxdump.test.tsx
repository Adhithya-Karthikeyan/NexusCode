/**
 * THROWAWAY audit harness — renders every preset + overlay at several terminal
 * sizes and dumps the ANSI-stripped frames to disk so they can be eyeballed.
 * Not part of the suite; deleted after the audit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { render } from "ink-testing-library";
import { describe, it } from "vitest";
import {
  CapabilityProvider,
  ThemeProvider,
  TuiApp,
  Conversation,
  CommandPalette,
  Picker,
  DiffView,
  TodoList,
  ToolActivity,
  StatusHud,
  reduceEvents,
  type Capabilities,
  type UiEvent,
} from "../src/index.js";

const OUT =
  process.env.UX_OUT ??
  "/private/tmp/claude-501/-Users-adhithya-Projects-apps-NexusCode/ed2e7802-772a-4ed6-a358-f7e8f4c3a538/scratchpad/ux/before";
mkdirSync(OUT, { recursive: true });

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const SIZES: Array<[number, number]> = [
  [60, 20],
  [80, 24],
  [100, 30],
  [140, 40],
];

function caps(cols: number, rows: number, over: Partial<Capabilities> = {}): Partial<Capabilities> {
  return {
    truecolor: true,
    colors256: true,
    unicode: true,
    noColor: false,
    screenReader: false,
    reducedMotion: false,
    isTTY: true,
    termDumb: false,
    width: cols,
    height: rows,
    ...over,
  };
}

const PATCH = `--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -14,7 +14,9 @@ export function createSession(user: User): Session {
-  const token = randomBytes(16).toString("hex");
+  const token = randomBytes(32).toString("base64url");
+  const expiresAt = Date.now() + SESSION_TTL_MS;
   return {
     id: user.id,
-    token,
+    token,
+    expiresAt,
   };
 }
`;

/** A realistic agentic session: prompt, thinking, tools, a diff, streaming text. */
const richEvents: UiEvent[] = [
  { t: "session", id: "run1", provider: "anthropic", model: "claude-opus-4-8", ts: 1 },
  { t: "route", chosen: "anthropic", reason: "explicit", candidates: ["anthropic", "openai"] },
  { t: "prompt", lane: "main", id: "p1", text: "Refactor the session token to be 32 bytes and add an expiry." },
  { t: "reasoning", lane: "main", delta: "The token is generated in createSession; widening it also needs the TTL constant." },
  { t: "tool_call", lane: "main", id: "t1", name: "read_file", args: { path: "src/auth/session.ts" } },
  { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
  { t: "tool_call", lane: "main", id: "t2", name: "bash", args: { command: "npm test -- packages/auth --reporter=dot" } },
  { t: "tool_result", lane: "main", id: "t2", ok: true, result: "42 passed" },
  { t: "text", lane: "main", delta: "I widened the token to 32 bytes and added an `expiresAt` field.\n\n## What changed\n\n- `createSession` now uses `randomBytes(32)` with base64url encoding\n- Sessions carry `expiresAt`, derived from `SESSION_TTL_MS`\n\n```ts\nconst token = randomBytes(32).toString(\"base64url\");\n```\n" },
  { t: "diff", lane: "main", path: "src/auth/session.ts", patch: PATCH },
  { t: "usage", lane: "main", inputTokens: 84200, outputTokens: 1350, costUsd: 0.41 },
  { t: "done", lane: "main", finishReason: "stop" },
  { t: "prompt", lane: "main", id: "p2", text: "Now update the tests." },
  { t: "tool_call", lane: "main", id: "t3", name: "edit_file", args: { path: "packages/auth/test/session.test.ts" } },
  { t: "text", lane: "main", delta: "Updating the assertions now" },
  { t: "usage", lane: "main", inputTokens: 91000, outputTokens: 400, costUsd: 0.12 },
];

/** A multi-lane race for the compare preset. */
const compareEvents: UiEvent[] = [
  { t: "session", id: "run2", provider: "anthropic", model: "claude-opus-4-8", ts: 1 },
  { t: "text", lane: "anthropic", delta: "Use a discriminated union keyed on `kind` so the compiler narrows exhaustively." },
  { t: "usage", lane: "anthropic", inputTokens: 4200, outputTokens: 220, costUsd: 0.08 },
  { t: "done", lane: "anthropic", finishReason: "stop" },
  { t: "text", lane: "openai", delta: "I'd model it as a class hierarchy with a visitor, which keeps the behaviour close to the data." },
  { t: "usage", lane: "openai", inputTokens: 4200, outputTokens: 310, costUsd: 0.03 },
  { t: "done", lane: "openai", finishReason: "stop" },
  { t: "text", lane: "google", delta: "A map of handlers is simplest and avoids both." },
  { t: "usage", lane: "google", inputTokens: 4200, outputTokens: 90, costUsd: 0.01 },
];

const sections: string[] = [];
function dump(label: string, frame: string, cols: number): void {
  const plain = strip(frame);
  const lines = plain.split("\n");
  const over = lines.filter((l) => l.length > cols);
  const ruler = "".padEnd(cols, "-");
  sections.push(
    [
      `### ${label}   (${cols} cols, ${lines.length} rows rendered)`,
      over.length ? `!! ${over.length} line(s) EXCEED ${cols} cols (max ${Math.max(...over.map((l) => l.length))})` : "",
      ruler,
      plain,
      ruler,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

describe("ux dump", () => {
  it("dumps every surface", () => {
    for (const [cols, rows] of SIZES) {
      // conversation (default surface)
      {
        const view = reduceEvents(richEvents);
        const { lastFrame } = render(
          <CapabilityProvider caps={caps(cols, rows)}>
            <ThemeProvider>
              <Conversation view={view} viewport={{ cols, rows }} contextMax={200000} inputActive={false} />
            </ThemeProvider>
          </CapabilityProvider>,
        );
        dump(`PRESET conversation`, lastFrame() ?? "", cols);
      }
      for (const preset of ["chat", "agent", "compare", "dashboard"] as const) {
        const { lastFrame } = render(
          <TuiApp
            caps={caps(cols, rows)}
            viewport={{ cols, rows }}
            preset={preset}
            sessionName="refactor-auth"
            events={preset === "compare" ? compareEvents : richEvents}
            inputActive={false}
            contextMax={200000}
          />,
        );
        dump(`PRESET ${preset}`, lastFrame() ?? "", cols);
      }
    }

    // Overlays / components at 80 cols.
    const view = reduceEvents(richEvents);
    const overlayCaps = caps(80, 24);
    const wrap = (n: React.ReactNode) => (
      <CapabilityProvider caps={overlayCaps}>
        <ThemeProvider>{n}</ThemeProvider>
      </CapabilityProvider>
    );
    {
      const { lastFrame } = render(
        wrap(
          <CommandPalette
            open
            query="mod"
            actions={[
              { id: "model", title: "Switch model", hint: "ctrl+m", group: "Session" },
              { id: "mode", title: "Cycle mode", hint: "shift+tab", group: "Session" },
              { id: "theme", title: "Change theme", group: "Appearance" },
            ]}
          />,
        ),
      );
      dump("OVERLAY CommandPalette", lastFrame() ?? "", 80);
    }
    {
      const { lastFrame } = render(
        wrap(
          <Picker
            title="Select model"
            items={[
              { value: "a", label: "claude-opus-4-8", hint: "anthropic" },
              { value: "b", label: "gpt-5", hint: "openai" },
              { value: "c", label: "gemini-3-pro", hint: "google" },
            ]}
            isActive={false}
          />,
        ),
      );
      dump("OVERLAY Picker", lastFrame() ?? "", 80);
    }
    {
      const { lastFrame } = render(wrap(<DiffView patch={PATCH} />));
      dump("COMPONENT DiffView", lastFrame() ?? "", 80);
    }
    {
      const { lastFrame } = render(
        wrap(
          <TodoList
            items={[
              { id: "1", label: "Widen session token to 32 bytes", status: "done" },
              { id: "2", label: "Add expiresAt to the Session type", status: "doing" },
              { id: "3", label: "Update the auth test suite", status: "todo" },
              { id: "4", label: "Backfill existing sessions", status: "blocked" },
            ]}
          />,
        ),
      );
      dump("COMPONENT TodoList", lastFrame() ?? "", 80);
    }
    {
      const { lastFrame } = render(
        wrap(
          <ToolActivity
            showCounts
            items={[
              { id: "t1", name: "read_file", status: "ok", detail: "src/auth/session.ts · 12ms" },
              { id: "t2", name: "bash", status: "running", detail: "npm test -- packages/auth" },
              { id: "t3", name: "edit_file", status: "error", detail: "packages/auth/test/session.test.ts" },
            ]}
          />,
        ),
      );
      dump("COMPONENT ToolActivity", lastFrame() ?? "", 80);
    }
    for (const c of [80, 120, 150]) {
      const { lastFrame } = render(wrap(<StatusHud view={view} cols={c} contextMax={200000} />));
      dump(`CHROME StatusHud`, lastFrame() ?? "", c);
    }
    // Degraded terminals at 80 cols.
    for (const [label, over] of [
      ["no-unicode", { unicode: false }],
      ["no-color", { noColor: true, truecolor: false, colors256: false }],
    ] as const) {
      const { lastFrame } = render(
        <CapabilityProvider caps={caps(80, 24, over)}>
          <ThemeProvider>
            <Conversation view={view} viewport={{ cols: 80, rows: 24 }} contextMax={200000} inputActive={false} />
          </ThemeProvider>
        </CapabilityProvider>,
      );
      dump(`DEGRADED conversation ${label}`, lastFrame() ?? "", 80);
    }

    writeFileSync(`${OUT}/frames.txt`, sections.join("\n"), "utf8");
  });
});
