/**
 * The specialized-agent registry (system-spec §5). Ships eight role presets plus
 * a coordinator, each an {@link AgentDefinition} whose `systemPrompt` is assembled
 * deterministically through `@nexuscode/prompt` (so identical roles yield
 * byte-stable, cache-friendly prompts). Roles differ in their tool allowlist,
 * sandbox class, step budget, and prompt — that is what makes a "reviewer" behave
 * differently from a "coder" while sharing one loop.
 */

import { PromptEngine } from "@nexuscode/prompt";
import type { PermissionMode } from "@nexuscode/tools";
import type { AgentDefinition, AgentRole } from "./types.js";

/** The tunable part of a role preset, before prompt assembly. */
interface RolePreset {
  description: string;
  capabilities: string[];
  conventions: string[];
  allowedTools: string[];
  maxSteps: number;
  permissionMode: PermissionMode;
  model?: string;
}

/** The shared system-prompt template id + version registered for every role. */
export const AGENT_PROMPT_ID = "agent.role";
export const AGENT_PROMPT_VERSION = "1";

const AGENT_PROMPT_BODY = [
  "# Role: {{role}}",
  "{{description}}",
  "",
  "## Capabilities",
  "{{capabilities}}",
  "",
  "## Operating Protocol",
  "You run an OODA loop: Observe (assemble the context and current plan), Reason",
  "(decide the next action), Plan (keep the task list current), Act (call tools),",
  "and Evaluate (self-critique against the goal). Repeat until the goal is met,",
  "a step budget is hit, or you are blocked. {{conventions}}",
  "",
  "## Allowed Tools",
  "{{tools}}",
].join("\n");

const ROLE_PRESETS: Record<AgentRole, RolePreset> = {
  coordinator: {
    description:
      "You are the coordinator. You decompose the objective into a plan, act on the parts you can, and delegate specialized subtasks to sub-agents.",
    capabilities: [
      "Break an objective into ordered, dependency-aware tasks.",
      "Delegate a subtask to the best-suited specialized agent.",
      "Track progress and dynamically replan when reality diverges.",
    ],
    conventions: ["Prefer delegation over doing specialized work yourself."],
    allowedTools: ["*"],
    maxSteps: 12,
    permissionMode: "workspace-write",
  },
  planner: {
    description:
      "You are the planner. You turn a fuzzy objective into a concrete, verifiable, dependency-ordered task plan.",
    capabilities: [
      "Produce a minimal task DAG that covers the objective.",
      "Identify risks and the definition of done for each task.",
    ],
    conventions: ["Do not write code; produce the plan only."],
    allowedTools: ["fs_read", "fs_search"],
    maxSteps: 4,
    permissionMode: "read-only",
  },
  coder: {
    description:
      "You are the coder. You implement changes to satisfy the plan, editing files and running commands as needed.",
    capabilities: [
      "Read, search, patch, and write files within the workspace.",
      "Run shell commands to build and verify.",
    ],
    conventions: ["Make the smallest change that satisfies the task; verify it."],
    allowedTools: ["fs_read", "fs_search", "fs_write", "fs_patch", "shell_exec"],
    maxSteps: 10,
    permissionMode: "workspace-write",
  },
  reviewer: {
    description:
      "You are the reviewer. You read the change and report correctness, clarity, and risk findings. You never modify files.",
    capabilities: [
      "Read and search the codebase to assess a change.",
      "Report findings ranked by severity.",
    ],
    conventions: ["Read-only: never write, patch, or execute."],
    allowedTools: ["fs_read", "fs_search"],
    maxSteps: 6,
    permissionMode: "read-only",
  },
  tester: {
    description:
      "You are the tester. You design and run tests that exercise the change and report pass/fail with evidence.",
    capabilities: ["Read code and tests.", "Run the test suite via the shell."],
    conventions: ["Prefer running existing tests before writing new ones."],
    allowedTools: ["fs_read", "fs_search", "fs_write", "shell_exec"],
    maxSteps: 8,
    permissionMode: "workspace-write",
  },
  researcher: {
    description:
      "You are the researcher. You gather and synthesize the information needed to act, citing where each fact came from.",
    capabilities: ["Read and search the codebase.", "Summarize findings for the coordinator."],
    conventions: ["Attribute every claim to a source."],
    allowedTools: ["fs_read", "fs_search"],
    maxSteps: 6,
    permissionMode: "read-only",
  },
  architect: {
    description:
      "You are the architect. You design the structure and interfaces before implementation, weighing trade-offs.",
    capabilities: ["Read the codebase.", "Produce an interface/dependency design."],
    conventions: ["Favor additive, contract-stable designs."],
    allowedTools: ["fs_read", "fs_search"],
    maxSteps: 5,
    permissionMode: "read-only",
  },
  "doc-writer": {
    description:
      "You are the doc-writer. You produce clear, accurate documentation for the change.",
    capabilities: ["Read the code being documented.", "Write documentation files."],
    conventions: ["Document behavior, not implementation trivia."],
    allowedTools: ["fs_read", "fs_search", "fs_write"],
    maxSteps: 6,
    permissionMode: "workspace-write",
  },
  "security-reviewer": {
    description:
      "You are the security reviewer. You hunt for vulnerabilities and unsafe patterns and report them by severity. You never modify files.",
    capabilities: [
      "Read and search the codebase for security issues.",
      "Report vulnerabilities ranked by severity with a remediation.",
    ],
    conventions: ["Read-only: never write, patch, or execute. Assume hostile input."],
    allowedTools: ["fs_read", "fs_search"],
    maxSteps: 6,
    permissionMode: "read-only",
  },
};

/** The canonical list of shipped roles. */
export const AGENT_ROLES = Object.keys(ROLE_PRESETS) as AgentRole[];

/** The registry of specialized agents. Build one via {@link createAgentRegistry}. */
export interface AgentRegistry {
  /** Resolve a role preset into its assembled {@link AgentDefinition}. */
  get(role: AgentRole | string): AgentDefinition;
  /** True if the role name is a shipped preset. */
  has(role: string): boolean;
  /** All shipped role names. */
  roles(): string[];
  /** The PromptEngine used to assemble role prompts (shared, for inspection). */
  readonly promptEngine: PromptEngine;
}

/** Register the shared role-prompt template on a PromptEngine (idempotent-safe per engine). */
export function registerAgentPrompts(engine: PromptEngine): void {
  if (!engine.hasTemplate(AGENT_PROMPT_ID, AGENT_PROMPT_VERSION)) {
    engine.registerTemplate(AGENT_PROMPT_ID, AGENT_PROMPT_VERSION, AGENT_PROMPT_BODY);
  }
}

function assemblePrompt(engine: PromptEngine, role: string, preset: RolePreset): string {
  return engine.assemble(
    AGENT_PROMPT_ID,
    {
      role,
      description: preset.description,
      capabilities: preset.capabilities.map((c) => `- ${c}`).join("\n"),
      conventions: preset.conventions.join(" "),
      tools: preset.allowedTools.includes("*")
        ? "All registered tools."
        : preset.allowedTools.map((t) => `- ${t}`).join("\n"),
    },
    { version: AGENT_PROMPT_VERSION },
  );
}

function definitionFrom(engine: PromptEngine, role: string, preset: RolePreset): AgentDefinition {
  const def: AgentDefinition = {
    role,
    systemPrompt: assemblePrompt(engine, role, preset),
    allowedTools: [...preset.allowedTools],
    maxSteps: preset.maxSteps,
    permissionMode: preset.permissionMode,
  };
  if (preset.model !== undefined) def.model = preset.model;
  return def;
}

/**
 * Create the specialized-agent registry. Accepts an optional PromptEngine so a
 * caller can share one engine across the app; otherwise a private one is built.
 */
export function createAgentRegistry(promptEngine?: PromptEngine): AgentRegistry {
  const engine = promptEngine ?? new PromptEngine();
  registerAgentPrompts(engine);

  const cache = new Map<string, AgentDefinition>();

  return {
    promptEngine: engine,
    has(role: string): boolean {
      return role in ROLE_PRESETS;
    },
    roles(): string[] {
      return [...AGENT_ROLES];
    },
    get(role: AgentRole | string): AgentDefinition {
      const cached = cache.get(role);
      if (cached) return cached;
      const preset = ROLE_PRESETS[role as AgentRole];
      if (!preset) throw new Error(`agent: unknown role "${role}"`);
      const def = definitionFrom(engine, role, preset);
      cache.set(role, def);
      return def;
    },
  };
}
