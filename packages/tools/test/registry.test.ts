import { describe, it, expect } from "vitest";
import { ToolRegistry, builtinTools, registerBuiltins, type Tool } from "@nexuscode/tools";

function stubTool(name: string, permission: Tool["permission"]): Tool {
  return {
    name,
    description: `stub ${name}`,
    parameters: { type: "object" },
    permission,
    run: async () => ({ ok: true, content: [] }),
  };
}

describe("ToolRegistry", () => {
  it("registers, looks up, and lists tools", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("a", "read"));
    expect(reg.has("a")).toBe(true);
    expect(reg.get("a").name).toBe("a");
    expect(reg.names()).toEqual(["a"]);
    expect(reg.list()).toHaveLength(1);
  });

  it("throws on duplicate name", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("a", "read"));
    expect(() => reg.register(stubTool("a", "write"))).toThrow(/duplicate/);
  });

  it("throws on missing tool", () => {
    const reg = new ToolRegistry();
    expect(() => reg.get("ghost")).toThrow(/ghost/);
  });

  it("selects by permission class", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("r", "read"));
    reg.register(stubTool("w", "write"));
    reg.register(stubTool("x", "exec"));
    expect(reg.selectByPermission("read").map((t) => t.name)).toEqual(["r"]);
    expect(reg.selectByPermission("write").map((t) => t.name)).toEqual(["w"]);
    expect(reg.selectByPermission("network")).toHaveLength(0);
  });

  it("unregister and clear work", () => {
    const reg = new ToolRegistry();
    reg.register(stubTool("a", "read"));
    expect(reg.unregister("a")).toBe(true);
    expect(reg.unregister("a")).toBe(false);
    reg.register(stubTool("b", "read"));
    reg.clear();
    expect(reg.names()).toEqual([]);
  });

  it("registers the full built-in suite", () => {
    const reg = new ToolRegistry();
    registerBuiltins(reg);
    expect(reg.names().sort()).toEqual(
      ["fs_patch", "fs_read", "fs_search", "fs_write", "shell_exec"].sort(),
    );
    // Each built-in exposes required metadata.
    for (const tool of builtinTools()) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeTypeOf("object");
      expect(["read", "write", "exec", "network"]).toContain(tool.permission);
      expect(typeof tool.run).toBe("function");
    }
  });
});
