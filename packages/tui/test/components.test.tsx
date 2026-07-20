import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  CapabilityProvider,
  ThemeProvider,
  ToolActivity,
  DiffView,
  parseUnifiedDiff,
  PlanTree,
  TodoList,
  planProgress,
  type Capabilities,
  type ToolActivityEntry,
  type PlanItem,
} from "../src/index.js";

/** A capable truecolor/unicode terminal for deterministic frames. */
const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  screenReader: false,
  reducedMotion: false,
  isTTY: true,
  termDumb: false,
  width: 120,
  height: 40,
};

function wrap(node: React.ReactNode, caps: Partial<Capabilities> = richCaps): React.JSX.Element {
  return (
    <CapabilityProvider caps={caps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>
  );
}

// SGR attribute opens (chalk): underline=4, strikethrough=9, dim=2.
const UNDERLINE = "[4m";
const STRIKE = "[9m";

describe("<ToolActivity> (§3.3)", () => {
  const items: ToolActivityEntry[] = [
    { id: "1", name: "read_file", status: "ok", detail: "1.2 kb" },
    { id: "2", name: "write_file", status: "running" },
    { id: "3", name: "shell", status: "error", detail: "exit 1" },
    { id: "4", name: "delete", status: "denied" },
  ];

  it("renders one row per item with status glyph + name + detail", () => {
    const { lastFrame } = render(wrap(<ToolActivity items={items} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ read_file");
    expect(frame).toContain("1.2 kb");
    expect(frame).toContain("◴ write_file");
    expect(frame).toContain("✗ shell");
    expect(frame).toContain("⚠ delete"); // denied → warn glyph
  });

  it("shows an empty placeholder when there are no items", () => {
    const { lastFrame } = render(wrap(<ToolActivity items={[]} emptyLabel="nothing yet" />));
    expect(lastFrame() ?? "").toContain("· nothing yet");
  });

  it("respects `limit` (keeps the most recent rows)", () => {
    const { lastFrame } = render(wrap(<ToolActivity items={items} limit={1} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("delete");
    expect(frame).not.toContain("read_file");
  });

  it("renders a count summary when asked", () => {
    const { lastFrame } = render(wrap(<ToolActivity items={items} showCounts />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓1"); // one ok
    expect(frame).toContain("✗1"); // one error
  });

  it("degrades glyphs to ASCII on a non-unicode terminal", () => {
    const { lastFrame } = render(wrap(<ToolActivity items={items} />, { ...richCaps, unicode: false }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("v read_file"); // ✓ → v
    expect(frame).toContain("x shell"); // ✗ → x
    expect(frame).not.toContain("✓");
  });
});

describe("<DiffView> (§3.5)", () => {
  const patch = [
    "--- a/src/session/store.ts",
    "+++ b/src/session/store.ts",
    "@@ -10,4 +10,4 @@",
    " const store = create();",
    "-  return new MemoryStore();",
    "+  return new RedisStore({ url, ttl });",
    " }",
  ].join("\n");

  it("parses a unified diff into classified lines with line numbers", () => {
    const lines = parseUnifiedDiff(patch);
    const add = lines.find((l) => l.kind === "add");
    const del = lines.find((l) => l.kind === "del");
    expect(add?.text).toContain("RedisStore");
    expect(add?.newLn).toBe(11); // context at 10, add at 11
    expect(del?.text).toContain("MemoryStore");
    expect(del?.oldLn).toBe(11);
  });

  it("renders +/- gutters and a change count header", () => {
    const { lastFrame } = render(wrap(<DiffView patch={patch} path="src/session/store.ts" />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/session/store.ts");
    expect(frame).toContain("+1"); // one addition
    expect(frame).toContain("−1"); // one removal (unicode minus)
    expect(frame).toContain("+ ");
    expect(frame).toContain("− ");
    expect(frame).toContain("RedisStore");
    expect(frame).toContain("MemoryStore");
  });

  it("carries redundant underline/strike attrs so color is not load-bearing (§1.3.2)", () => {
    const { lastFrame } = render(wrap(<DiffView patch={patch} showHeader={false} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain(UNDERLINE); // added lines underlined
    expect(frame).toContain(STRIKE); // removed lines struck
  });

  it("shows a placeholder for an empty patch", () => {
    const { lastFrame } = render(wrap(<DiffView patch="" emptyLabel="binary skipped" />));
    expect(lastFrame() ?? "").toContain("· binary skipped");
  });
});

describe("<PlanTree> / <TodoList> (§3.4)", () => {
  const plan: PlanItem[] = [
    { id: "1", label: "Audit MemoryStore usage", status: "done" },
    {
      id: "3",
      label: "Introduce RedisStore adapter",
      status: "doing",
      children: [
        { id: "3a", label: "implement get/set/del", status: "todo" },
        { id: "3b", label: "wire TTL", status: "blocked" },
      ],
    },
    { id: "4", label: "Drop legacy path", status: "skipped" },
  ];

  it("tallies progress across nested nodes", () => {
    const p = planProgress(plan);
    expect(p.total).toBe(5); // 3 top + 2 children
    expect(p.done).toBe(1);
    expect(p.blocked).toBe(1);
  });

  it("renders nested subtasks with status glyphs and a progress header", () => {
    const { lastFrame } = render(wrap(<PlanTree items={plan} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1/5 ✓");
    expect(frame).toContain("1 blocked");
    expect(frame).toContain("✓ Audit MemoryStore usage"); // done
    expect(frame).toContain("▸ Introduce RedisStore adapter"); // doing
    expect(frame).toContain("○ implement get/set/del"); // todo, indented child
    expect(frame).toContain("▲ wire TTL"); // blocked
    expect(frame).toContain("⊘ Drop legacy path"); // skipped
  });

  it("strikes through skipped labels (redundant with the glyph)", () => {
    const { lastFrame } = render(wrap(<PlanTree items={[{ id: "x", label: "gone", status: "skipped" }]} />));
    expect(lastFrame() ?? "").toContain(STRIKE);
  });

  it("renders an empty placeholder", () => {
    const { lastFrame } = render(wrap(<PlanTree items={[]} />));
    expect(lastFrame() ?? "").toContain("· no plan");
  });

  it("<TodoList> renders a flat list ignoring nesting", () => {
    const { lastFrame } = render(wrap(<TodoList items={plan} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ Audit MemoryStore usage");
    expect(frame).toContain("▸ Introduce RedisStore adapter");
    // Flat: children are not emitted as their own rows.
    expect(frame).not.toContain("implement get/set/del");
  });

  it("degrades glyphs to ASCII on a non-unicode terminal", () => {
    const { lastFrame } = render(wrap(<PlanTree items={plan} />, { ...richCaps, unicode: false }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("v Audit MemoryStore usage"); // ✓ → v
    expect(frame).toContain("! wire TTL"); // ▲ → !
    expect(frame).not.toContain("✓");
  });
});
