/**
 * ToolRegistry — the tool analogue of the provider registry. The engine
 * registers built-in, MCP, and wrapped-CLI tools here once; the orchestrator
 * looks them up by name or filters by permission class. Mirrors
 * `ProviderRegistry`'s throw-on-duplicate / throw-on-missing discipline.
 */

import { NexusError } from "@nexuscode/shared";
import type { Tool, ToolPermission } from "./types.js";

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  /** Register a tool. Throws on a duplicate name. */
  register(tool: Tool): void {
    if (this.byName.has(tool.name)) {
      throw new NexusError("invalid_argument", `duplicate tool name: ${tool.name}`);
    }
    this.byName.set(tool.name, tool);
  }

  /** Register many tools in order. */
  registerAll(tools: Iterable<Tool>): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Resolve a tool by name; throws `NexusError("invalid_argument")` if absent. */
  get(name: string): Tool {
    const tool = this.byName.get(name);
    if (!tool) throw new NexusError("invalid_argument", `no tool "${name}"`);
    return tool;
  }

  list(): Tool[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** All tools in a given permission class. */
  selectByPermission(permission: ToolPermission): Tool[] {
    return this.list().filter((t) => t.permission === permission);
  }

  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  clear(): void {
    this.byName.clear();
  }
}
