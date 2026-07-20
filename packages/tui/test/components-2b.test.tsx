import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  CapabilityProvider,
  CommandPalette,
  ContextGauge,
  CostMeter,
  Icon,
  ModelBadge,
  NotificationCenter,
  ProviderHealthDot,
  Toast,
  costTier,
  filterActions,
  fuzzyScore,
  gaugeTier,
  resolveIcon,
  staleness,
  stringWidth,
  ThemeProvider,
  type Capabilities,
  type NotificationItem,
  type PaletteAction,
  type ProviderHealth,
} from "../src/index.js";

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

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
/** Let Ink flush effects (input listener attach / timers) before asserting. */
// 40ms (not 0) so ink has really mounted and registered its input handlers before
// the next stdin.write lands. A 0ms tick is enough on a fast dev machine but races
// on slower CI runners, where the keystroke arrives before the handler exists and
// silently does nothing. Matches the other TUI test files.
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

function wrap(node: React.ReactNode, caps: Partial<Capabilities> = richCaps): React.JSX.Element {
  return (
    <CapabilityProvider caps={caps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>
  );
}

// ── Icon resolver (width-probe + ASCII downgrade) ──────────────────────────────

describe("<Icon> resolver (§3.0)", () => {
  it("stringWidth counts wide/zero-width code points", () => {
    expect(stringWidth("ab")).toBe(2);
    expect(stringWidth("◆")).toBe(1); // BMP single-cell marker
    expect(stringWidth("界")).toBe(2); // CJK wide
    expect(stringWidth("🔎")).toBe(2); // astral emoji wide
    expect(stringWidth("á")).toBe(1); // combining accent is zero-width
  });

  it("keeps single-cell unicode markers but downgrades astral emoji in aligned rows", () => {
    expect(resolveIcon("node", { unicode: true })).toBe("◆");
    expect(resolveIcon("bolt", { unicode: true })).toBe("⚡");
    // 🔎 measures 2 cells → downgrades to its ASCII fallback even with unicode on.
    expect(resolveIcon("search", { unicode: true })).toBe(":");
  });

  it("downgrades every glyph on a non-unicode terminal", () => {
    expect(resolveIcon("node", { unicode: false })).toBe("*");
    expect(resolveIcon("ok", { unicode: false })).toBe("v");
    expect(resolveIcon("autocompact", { unicode: false })).toBe("t");
  });

  it("honours an injected width oracle (boot probe) to force a downgrade", () => {
    // A terminal that double-widths the diamond → resolver drops to ASCII.
    expect(resolveIcon("node", { unicode: true }, () => 2)).toBe("*");
  });

  it("renders a glyph through the component", () => {
    const { lastFrame } = render(wrap(<Icon name="node" />));
    expect(strip(lastFrame())).toContain("◆");
  });
});

// ── ProviderHealthDot ──────────────────────────────────────────────────────────

describe("<ProviderHealthDot> (§3.7)", () => {
  const health: ProviderHealth = { provider: "anthropic", status: "ok", note: "ok", lastTs: 1000 };

  it("carries dot + letter + word (never color-only) with a staleness cue", () => {
    const { lastFrame } = render(wrap(<ProviderHealthDot health={health} active nowTs={4000} />));
    const f = strip(lastFrame());
    expect(f).toContain("●");
    expect(f).toContain("A"); // provider letter tag
    expect(f).toContain("ok");
    expect(f).toContain("·3s"); // staleness
  });

  it("uses a hollow dot when not active and hides staleness when nowTs omitted", () => {
    const { lastFrame } = render(wrap(<ProviderHealthDot health={health} showName />));
    const f = strip(lastFrame());
    expect(f).toContain("○");
    expect(f).toContain("anthropic");
    expect(f).not.toContain("·");
  });

  it("staleness formats seconds/minutes/hours", () => {
    expect(staleness(0, 3000)).toBe("3s");
    expect(staleness(0, 120000)).toBe("2m");
    expect(staleness(0, 3600000)).toBe("1h");
  });
});

// ── ModelBadge ───────────────────────────────────────────────────────────────

describe("<ModelBadge> (§2.3)", () => {
  it("shows served model + provider with hue dot + letter", () => {
    const { lastFrame } = render(wrap(<ModelBadge model="Opus 4.8" provider="anthropic" />));
    const f = strip(lastFrame());
    expect(f).toContain("●");
    expect(f).toContain("A");
    expect(f).toContain("Opus 4.8");
    expect(f).toContain("(anthropic)");
  });

  it("flags an unverified served model", () => {
    const { lastFrame } = render(wrap(<ModelBadge model="gpt-5.1" provider="openai" verified={false} />));
    expect(strip(lastFrame())).toContain("unverified");
  });
});

// ── CostMeter ────────────────────────────────────────────────────────────────

describe("<CostMeter> (§3.7)", () => {
  it("costTier ramps at 0.75 / 0.9 of the cap", () => {
    expect(costTier(1, 10)).toBe("ok");
    expect(costTier(8, 10)).toBe("warn");
    expect(costTier(9.5, 10)).toBe("crit");
    expect(costTier(5)).toBe("ok"); // no cap → always ok
  });

  it("renders session + run spend", () => {
    const { lastFrame } = render(wrap(<CostMeter sessionUsd={0.41} runUsd={0.06} />));
    const f = strip(lastFrame());
    expect(f).toContain("$0.41 session");
    expect(f).toContain("$0.06 run");
  });

  it("shows the degrade notice on/over the cap", () => {
    const { lastFrame } = render(wrap(<CostMeter sessionUsd={5} cap={5} />));
    const f = strip(lastFrame());
    expect(f).toContain("cap $5.00");
    expect(f).toContain("degrading");
  });
});

// ── ContextGauge ─────────────────────────────────────────────────────────────

describe("<ContextGauge> (§2.5)", () => {
  it("gaugeTier lights warn at the autocompact threshold and crit near the limit", () => {
    expect(gaugeTier(0.2, 0.85)).toBe("ok");
    expect(gaugeTier(0.86, 0.85)).toBe("warn");
    expect(gaugeTier(0.95, 0.85)).toBe("crit");
  });

  it("renders the real window and a nominal-window callout", () => {
    const { lastFrame } = render(wrap(<ContextGauge used={84200} max={200000} nominal={1000000} />));
    const f = strip(lastFrame());
    expect(f).toContain("ctx");
    expect(f).toContain("84.2k/200.0k");
    expect(f).toContain("nominal");
  });

  it("shows the autocompact tick past threshold", () => {
    const { lastFrame } = render(wrap(<ContextGauge used={190000} max={200000} autocompactAt={0.85} />));
    expect(strip(lastFrame())).toContain("autocompact");
  });
});

// ── Toast / NotificationCenter ────────────────────────────────────────────────

describe("<Toast> (§3.8)", () => {
  it("renders a level glyph + message", () => {
    const { lastFrame } = render(wrap(<Toast message="rate-limited" level="warning" />));
    const f = strip(lastFrame());
    expect(f).toContain("⚠");
    expect(f).toContain("rate-limited");
  });

  it("renders a titled body with the level word", () => {
    const { lastFrame } = render(wrap(<Toast title="failover" message="to openai" level="info" />));
    const f = strip(lastFrame());
    expect(f).toContain("failover");
    expect(f).toContain("info");
    expect(f).toContain("to openai");
  });

  it("self-dismisses after ttl", async () => {
    const onExpire = vi.fn();
    render(wrap(<Toast message="hi" ttlMs={20} onExpire={onExpire} />));
    await new Promise((r) => setTimeout(r, 60));
    expect(onExpire).toHaveBeenCalledOnce();
  });
});

describe("<NotificationCenter> (§2.2)", () => {
  it("renders an explicit empty state (no blank void)", () => {
    const { lastFrame } = render(wrap(<NotificationCenter items={[]} />));
    const f = strip(lastFrame());
    expect(f).toContain("Notifications");
    expect(f).toContain("no notifications");
  });

  it("maps store notifications to level-coded rows, newest first", () => {
    const items: NotificationItem[] = [
      { kind: "approval", lane: "main", ts: 1, title: "approval: write", detail: "src/x.ts" },
      { kind: "error", lane: "main", ts: 2, title: "error: 429", detail: "rate limit", retryable: true },
    ];
    const { lastFrame } = render(wrap(<NotificationCenter items={items} />));
    const f = strip(lastFrame());
    expect(f).toContain("error: 429");
    expect(f).toContain("approval: write");
    expect(f).toContain("· 2"); // count
  });

  it("collapses overflow beyond max", () => {
    const items: NotificationItem[] = Array.from({ length: 7 }, (_, i) => ({
      kind: "error" as const,
      lane: "main",
      ts: i,
      title: `err ${i}`,
      detail: "boom",
    }));
    const { lastFrame } = render(wrap(<NotificationCenter items={items} max={3} />));
    expect(strip(lastFrame())).toContain("4 earlier");
  });
});

// ── CommandPalette ────────────────────────────────────────────────────────────

const ACTIONS: PaletteAction[] = [
  { id: "compare", title: "/compare", subtitle: "run this prompt on N providers", group: "run", keybinding: "⌃R" },
  { id: "race", title: "/race", subtitle: "first-good-wins, cancel losers", group: "run" },
  { id: "layout-compare", title: "layout: compare", subtitle: "switch to compare grid", group: "layout" },
  { id: "theme-edit", title: "/theme edit", subtitle: "live-edit the running theme", group: "theme" },
];

describe("fuzzy scoring (§6.5)", () => {
  it("scores contiguous / boundary matches higher and rejects non-subsequences", () => {
    expect(fuzzyScore("cmp", "/compare")).not.toBeNull();
    expect(fuzzyScore("zzz", "/compare")).toBeNull();
    const contiguous = fuzzyScore("comp", "/compare")!.score;
    const scattered = fuzzyScore("cpr", "/compare")!.score;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("returns matched positions for highlighting", () => {
    const m = fuzzyScore("cmp", "/compare")!;
    expect(m.positions.length).toBe(3);
    expect([..."/compare"][m.positions[0]!]).toBe("c");
  });

  it("filterActions keeps registry order for an empty query and ranks otherwise", () => {
    const all = filterActions(ACTIONS, "");
    expect(all.map((m) => m.action.id)).toEqual(["compare", "race", "layout-compare", "theme-edit"]);
    const ranked = filterActions(ACTIONS, "comp");
    expect(ranked[0]!.action.id).toBe("compare"); // best title hit ranks first
    expect(ranked.some((m) => m.action.id === "race")).toBe(false); // no 'comp' subsequence
  });
});

describe("<CommandPalette> overlay (§2.10)", () => {
  it("lists actions with their bound chord and hit count", () => {
    const { lastFrame } = render(wrap(<CommandPalette actions={ACTIONS} />));
    const f = strip(lastFrame());
    expect(f).toContain("Command Palette");
    expect(f).toContain("/compare");
    expect(f).toContain("⌃R"); // teaches the keybinding
    expect(f).toContain("4 hits");
  });

  it("filters live via the injected initial query", () => {
    const { lastFrame } = render(wrap(<CommandPalette actions={ACTIONS} initialQuery="race" />));
    const f = strip(lastFrame());
    expect(f).toContain("/race");
    expect(f).not.toContain("/theme edit");
    expect(f).toContain("1 hit");
  });

  it("runs the selected action on Enter and closes", async () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      wrap(<CommandPalette actions={ACTIONS} initialQuery="race" onRun={onRun} onClose={onClose} />),
    );
    await tick();
    stdin.write("\r"); // Enter
    await tick();
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun.mock.calls[0]![0]).toMatchObject({ id: "race" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Esc without running", async () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(wrap(<CommandPalette actions={ACTIONS} onRun={onRun} onClose={onClose} />));
    await tick();
    stdin.write(""); // Esc
    await tick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("types to filter and Enter runs the top match", async () => {
    const onRun = vi.fn();
    const { stdin } = render(wrap(<CommandPalette actions={ACTIONS} onRun={onRun} />));
    await tick();
    stdin.write("t"); // -> /theme edit is the strongest 't' title hit
    await tick();
    stdin.write("\r");
    await tick();
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun.mock.calls[0]![0]).toMatchObject({ id: "theme-edit" });
  });
});
