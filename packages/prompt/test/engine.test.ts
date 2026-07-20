import { describe, it, expect } from "vitest";
import { PromptEngine } from "@nexuscode/prompt";
import { NexusError } from "@nexuscode/shared";

describe("PromptEngine — templates & assembly", () => {
  it("registers and assembles a template with interpolation", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("greet", "1.0.0", "Hello {{name}}, welcome to {{project}}.");
    expect(pe.assemble("greet", { name: "Ada", project: "NexusCode" })).toBe(
      "Hello Ada, welcome to NexusCode.",
    );
  });

  it("reports referenced variables of a template", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("t", "1", "{{a}} and {{b}} and {{a}}");
    expect(pe.variablesOf("t")).toEqual(["a", "b"]);
  });

  it("propagates missing-var behavior from assemble options", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("t", "1", "Hi {{who}}");
    expect(() => pe.assemble("t", {})).toThrow(NexusError);
    expect(pe.assemble("t", {}, { onMissing: "empty" })).toBe("Hi ");
  });

  it("throws for an unknown template id", () => {
    const pe = new PromptEngine();
    expect(() => pe.assemble("ghost", {})).toThrow(/unknown template/);
    expect(pe.hasTemplate("ghost")).toBe(false);
  });
});

describe("PromptEngine — few-shot blocks", () => {
  it("appends a deterministic few-shot block after the body", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("task", "1", "Do the task for {{lang}}.");
    const out = pe.assemble(
      "task",
      { lang: "TS" },
      {
        fewShot: [
          { input: "2+2", output: "4" },
          { input: "3+3", output: "6", label: "Add" },
        ],
      },
    );
    expect(out).toBe(
      [
        "Do the task for TS.",
        "",
        "Examples:",
        "",
        "Input:\n2+2\nOutput:\n4",
        "",
        "## Example: Add\nInput:\n3+3\nOutput:\n6",
      ].join("\n"),
    );
  });

  it("omits the few-shot block when none are given", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("task", "1", "body");
    expect(pe.assemble("task", {})).toBe("body");
    expect(pe.assemble("task", {}, { fewShot: [] })).toBe("body");
  });
});

describe("PromptEngine — versioning", () => {
  it("defaults to the latest registered version and records the version used", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("sys", "1.0.0", "v1 body");
    pe.registerTemplate("sys", "2.0.0", "v2 body");
    expect(pe.latestVersion("sys")).toBe("2.0.0");
    expect(pe.assemble("sys", {})).toBe("v2 body");
    expect(pe.lastUsedVersion("sys")).toBe("2.0.0");
  });

  it("assembles a pinned version and records exactly that version", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("sys", "1.0.0", "v1 body");
    pe.registerTemplate("sys", "2.0.0", "v2 body");
    expect(pe.assemble("sys", {}, { version: "1.0.0" })).toBe("v1 body");
    expect(pe.lastUsedVersion("sys")).toBe("1.0.0");
    expect(pe.versions("sys")).toEqual(["1.0.0", "2.0.0"]);
  });

  it("records the full assembly log in order", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("a", "1", "A");
    pe.registerTemplate("b", "2", "B");
    pe.assemble("a", {});
    pe.assemble("b", {});
    pe.assemble("a", {});
    expect(pe.usageLog()).toEqual([
      { id: "a", version: "1" },
      { id: "b", version: "2" },
      { id: "a", version: "1" },
    ]);
  });

  it("rejects re-registering an existing (id, version) pair", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("a", "1", "A");
    expect(() => pe.registerTemplate("a", "1", "A2")).toThrow(/already registered/);
  });

  it("throws when a pinned version does not exist", () => {
    const pe = new PromptEngine();
    pe.registerTemplate("a", "1", "A");
    expect(() => pe.assemble("a", {}, { version: "9" })).toThrow(/unknown template version/);
  });

  it("rejects empty id or version", () => {
    const pe = new PromptEngine();
    expect(() => pe.registerTemplate("", "1", "x")).toThrow(NexusError);
    expect(() => pe.registerTemplate("a", "", "x")).toThrow(NexusError);
  });
});

describe("PromptEngine — compose (deterministic system prompt)", () => {
  it("orders sections identity -> capabilities -> memory -> conventions", () => {
    const pe = new PromptEngine();
    const out = pe.compose({
      identity: "You are NexusCode.",
      capabilities: ["Edit files", "Run shell"],
      memory: ["Repo uses npm workspaces."],
      conventions: ["Prefer named exports."],
    });
    expect(out).toBe(
      [
        "# Identity",
        "You are NexusCode.",
        "",
        "# Capabilities",
        "Edit files",
        "Run shell",
        "",
        "# Memory",
        "Repo uses npm workspaces.",
        "",
        "# Project Conventions",
        "Prefer named exports.",
      ].join("\n"),
    );
  });

  it("is deterministic — identical parts produce byte-identical output", () => {
    const pe = new PromptEngine();
    const parts = {
      identity: "id",
      capabilities: ["c1", "c2"],
      memory: ["m1"],
      conventions: ["k1"],
    };
    expect(pe.compose(parts)).toBe(pe.compose(parts));
  });

  it("omits empty sections and trims blank entries", () => {
    const pe = new PromptEngine();
    const out = pe.compose({
      identity: "  You are NexusCode.  ",
      capabilities: ["", "  ", "Edit files"],
      memory: [],
    });
    expect(out).toBe(["# Identity", "You are NexusCode.", "", "# Capabilities", "Edit files"].join("\n"));
  });

  it("returns an empty string when no parts are provided", () => {
    const pe = new PromptEngine();
    expect(pe.compose({})).toBe("");
  });
});
