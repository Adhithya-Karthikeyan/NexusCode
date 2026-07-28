/**
 * `parseApprovalDecision`/`parseSwitchDecision` (`packages/cli/src/commands.ts`)
 * — the two control-line parsers `nexus chat --persistent` uses to tell a
 * control line (JSON arriving on the SAME stdin the prompts use) apart from
 * an ordinary chat prompt.
 *
 * Both parsers are THREE-valued (`{kind:"none"|"valid"|"malformed"}`), not
 * two — see their doc comments in `commands.ts`. The bug this closes: a line
 * that unambiguously declares itself a control line (its `type` matches) but
 * is otherwise malformed used to collapse into the same result as "not a
 * control line at all", so both reading loops silently dispatched it to the
 * model as an ordinary chat prompt — a billed turn with zero feedback that
 * anything was rejected. `"malformed"` must never be confused with `"none"`.
 *
 * These are real unit tests, not integration — both parsers are pure
 * functions over a string, so there is nothing to mock. The end-to-end proof
 * that a malformed line never reaches the model lives in
 * `cli.integration.test.ts` (spawns the real built binary).
 */
import { describe, expect, it } from "vitest";
import { parseApprovalDecision, parseSwitchDecision } from "../src/commands.js";

describe("parseApprovalDecision", () => {
  it('kind "none" — not JSON at all, falls through as an ordinary prompt', () => {
    expect(parseApprovalDecision("hello there")).toEqual({ kind: "none" });
  });

  it('kind "none" — valid JSON that is not this control line\'s shape', () => {
    expect(parseApprovalDecision("42")).toEqual({ kind: "none" });
    expect(parseApprovalDecision("null")).toEqual({ kind: "none" });
    expect(parseApprovalDecision("[]")).toEqual({ kind: "none" });
    expect(parseApprovalDecision('{"hello":"world"}')).toEqual({ kind: "none" });
    // A DIFFERENT control line's shape (a switch line) is also "none" here —
    // each parser recognizes only its own `type`.
    expect(parseApprovalDecision(JSON.stringify({ type: "switch", provider: "mock" }))).toEqual({
      kind: "none",
    });
  });

  it('kind "valid" — the exact documented shape, both decisions', () => {
    expect(parseApprovalDecision(JSON.stringify({ type: "approval", id: "abc", decision: "allow" }))).toEqual({
      kind: "valid",
      id: "abc",
      decision: "allow",
    });
    expect(parseApprovalDecision(JSON.stringify({ type: "approval", id: "abc", decision: "deny" }))).toEqual({
      kind: "valid",
      id: "abc",
      decision: "deny",
    });
  });

  it('kind "malformed" — type:"approval" but id is missing or empty', () => {
    const r1 = parseApprovalDecision(JSON.stringify({ type: "approval", decision: "allow" }));
    expect(r1.kind).toBe("malformed");
    expect((r1 as { reason: string }).reason).toMatch(/id/i);

    const r2 = parseApprovalDecision(JSON.stringify({ type: "approval", id: "", decision: "allow" }));
    expect(r2.kind).toBe("malformed");
  });

  it('kind "malformed" — type:"approval" but decision is missing or invalid, never falls through as a prompt', () => {
    const r1 = parseApprovalDecision(JSON.stringify({ type: "approval", id: "abc" }));
    expect(r1.kind).toBe("malformed");
    expect((r1 as { reason: string }).reason).toMatch(/decision/i);

    const r2 = parseApprovalDecision(JSON.stringify({ type: "approval", id: "abc", decision: "maybe" }));
    expect(r2.kind).toBe("malformed");
    expect((r2 as { reason: string }).reason).toContain("maybe");
  });
});

describe("parseSwitchDecision", () => {
  it('kind "none" — not JSON at all, falls through as an ordinary prompt', () => {
    expect(parseSwitchDecision("please switch topics to gardening")).toEqual({ kind: "none" });
  });

  it('kind "none" — valid JSON that is not this control line\'s shape', () => {
    expect(parseSwitchDecision("42")).toEqual({ kind: "none" });
    expect(parseSwitchDecision("[]")).toEqual({ kind: "none" });
    expect(parseSwitchDecision('{"hello":"world"}')).toEqual({ kind: "none" });
    expect(
      parseSwitchDecision(JSON.stringify({ type: "approval", id: "abc", decision: "allow" })),
    ).toEqual({ kind: "none" });
  });

  it('kind "valid" — provider only, and provider+model', () => {
    expect(parseSwitchDecision(JSON.stringify({ type: "switch", provider: "mock" }))).toEqual({
      kind: "valid",
      provider: "mock",
    });
    expect(
      parseSwitchDecision(JSON.stringify({ type: "switch", provider: "mock", model: "mock-fast" })),
    ).toEqual({
      kind: "valid",
      provider: "mock",
      model: "mock-fast",
    });
  });

  it('kind "malformed" — type:"switch" but provider is missing or empty (the reported bug\'s exact repro)', () => {
    // The concrete case that was silently mis-handled before this fix:
    // `provider` is required, so a client that forgot it got the raw JSON
    // string dispatched to the model as a prompt with zero feedback that the
    // switch was rejected — indistinguishable from "switching doesn't work".
    const r1 = parseSwitchDecision(JSON.stringify({ type: "switch", model: "claude-sonnet-5" }));
    expect(r1.kind).toBe("malformed");
    expect((r1 as { reason: string }).reason).toMatch(/provider/i);

    const r2 = parseSwitchDecision(JSON.stringify({ type: "switch", provider: "" }));
    expect(r2.kind).toBe("malformed");
  });

  it('kind "malformed" — type:"switch" but model is present and invalid', () => {
    const r1 = parseSwitchDecision(JSON.stringify({ type: "switch", provider: "mock", model: 123 }));
    expect(r1.kind).toBe("malformed");
    expect((r1 as { reason: string }).reason).toMatch(/model/i);

    const r2 = parseSwitchDecision(JSON.stringify({ type: "switch", provider: "mock", model: "" }));
    expect(r2.kind).toBe("malformed");
  });
});
