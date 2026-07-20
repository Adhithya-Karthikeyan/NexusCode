/**
 * The starter built-in tool suite (§6): filesystem read/write/patch/search and a
 * sandboxed shell. `builtinTools()` returns fresh references; `registerBuiltins`
 * loads them into a registry in one call.
 */

import { fsReadTool, fsSearchTool, fsWriteTool } from "./fs.js";
import { fsPatchTool } from "./patch.js";
import { shellExecTool } from "./shell.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

/** All starter built-in tools, in a stable order. */
export function builtinTools(): Tool[] {
  return [fsReadTool, fsWriteTool, fsPatchTool, fsSearchTool, shellExecTool];
}

/** Register every built-in tool into `registry`. */
export function registerBuiltins(registry: ToolRegistry): void {
  registry.registerAll(builtinTools());
}
