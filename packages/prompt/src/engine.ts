/**
 * PromptEngine (system-spec §8) — system prompts, task prompts, dynamic
 * assembly, named + versioned templates, safe `{{variable}}` interpolation,
 * few-shot blocks, and deterministic system-prompt composition.
 *
 * Two invariants drive the design:
 *  1. Determinism — identical inputs always yield byte-identical output, so a
 *     provider prompt-cache prefix stays stable turn to turn.
 *  2. Versioning — every registered template carries an explicit `version`, and
 *     each `assemble()` records exactly which version produced the string.
 */

import { NexusError } from "@nexuscode/shared";
import { interpolate, referencedVars, type PromptVars } from "./interpolate.js";
import type {
  AssembleOptions,
  AssemblyRecord,
  ComposeParts,
  FewShotExample,
  Template,
} from "./types.js";

interface TemplateFamily {
  /** version -> body */
  versions: Map<string, string>;
  /** registration order; the last entry is the "latest". */
  order: string[];
}

/** Render a deterministic few-shot block. Stable formatting for cache safety. */
function renderFewShot(examples: readonly FewShotExample[]): string {
  const blocks = examples.map((ex) => {
    const head = ex.label ? `## Example: ${ex.label}\n` : "";
    return `${head}Input:\n${ex.input}\nOutput:\n${ex.output}`;
  });
  return `Examples:\n\n${blocks.join("\n\n")}`;
}

export class PromptEngine {
  private readonly templates = new Map<string, TemplateFamily>();
  private readonly log: AssemblyRecord[] = [];

  /**
   * Register a template body under `id` at `version`. A given `(id, version)`
   * pair may be registered only once — re-registering a version is rejected,
   * because silently mutating a version would break cache/version guarantees.
   */
  registerTemplate(id: string, version: string, body: string): void {
    if (!id) throw new NexusError("invalid_argument", "template id is required");
    if (!version) throw new NexusError("invalid_argument", "template version is required");
    let family = this.templates.get(id);
    if (!family) {
      family = { versions: new Map(), order: [] };
      this.templates.set(id, family);
    }
    if (family.versions.has(version)) {
      throw new NexusError("invalid_argument", `template ${id}@${version} is already registered`, {
        detail: { id, version },
      });
    }
    family.versions.set(version, body);
    family.order.push(version);
  }

  /** True if the id (and, when given, that specific version) exists. */
  hasTemplate(id: string, version?: string): boolean {
    const family = this.templates.get(id);
    if (!family) return false;
    return version === undefined ? true : family.versions.has(version);
  }

  /** All registered versions of `id`, in registration order. */
  versions(id: string): string[] {
    return [...(this.templates.get(id)?.order ?? [])];
  }

  /** The version `assemble()` would pick for `id` (latest = last registered). */
  latestVersion(id: string): string {
    return this.resolveVersion(id);
  }

  /** Resolve a template body, defaulting to the latest version. */
  getTemplate(id: string, version?: string): Template {
    const family = this.requireFamily(id);
    const v = version ?? this.resolveVersion(id);
    const body = family.versions.get(v);
    if (body === undefined) {
      throw new NexusError("invalid_argument", `unknown template version: ${id}@${v}`, {
        detail: { id, version: v },
      });
    }
    return { id, version: v, body };
  }

  /** Variables referenced by a template body (unique, sorted). */
  variablesOf(id: string, version?: string): string[] {
    return referencedVars(this.getTemplate(id, version).body);
  }

  /**
   * Assemble a template into a finished prompt string: resolve the version,
   * interpolate `vars`, append any few-shot block, and record the version used.
   */
  assemble(id: string, vars: PromptVars = {}, options: AssembleOptions = {}): string {
    const { body, version } = this.getTemplate(id, options.version);
    let out = interpolate(body, vars, options.onMissing ?? "throw");
    if (options.fewShot && options.fewShot.length > 0) {
      out = `${out}\n\n${renderFewShot(options.fewShot)}`;
    }
    this.log.push({ id, version });
    return out;
  }

  /** The full history of assemblies performed (id + version), in order. */
  usageLog(): readonly AssemblyRecord[] {
    return this.log;
  }

  /** The version most recently used by `assemble()` for `id`, if any. */
  lastUsedVersion(id: string): string | undefined {
    for (let i = this.log.length - 1; i >= 0; i--) {
      if (this.log[i]!.id === id) return this.log[i]!.version;
    }
    return undefined;
  }

  /**
   * Compose a full system prompt from named parts with a fixed, deterministic
   * section order — identity → capabilities → memory → conventions — so the most
   * static content forms a byte-stable cacheable prefix. Empty sections are
   * omitted; the same parts always serialize identically.
   */
  compose(parts: ComposeParts): string {
    const sections: string[] = [];
    const push = (title: string, value: string | string[] | undefined) => {
      const lines = Array.isArray(value)
        ? value.map((s) => s.trim()).filter((s) => s.length > 0)
        : value && value.trim().length > 0
          ? [value.trim()]
          : [];
      if (lines.length === 0) return;
      sections.push(`# ${title}\n${lines.join("\n")}`);
    };
    push("Identity", parts.identity);
    push("Capabilities", parts.capabilities);
    push("Memory", parts.memory);
    push("Project Conventions", parts.conventions);
    return sections.join("\n\n");
  }

  private requireFamily(id: string): TemplateFamily {
    const family = this.templates.get(id);
    if (!family) {
      throw new NexusError("invalid_argument", `unknown template: ${id}`, { detail: { id } });
    }
    return family;
  }

  private resolveVersion(id: string): string {
    const family = this.requireFamily(id);
    const latest = family.order[family.order.length - 1];
    if (latest === undefined) {
      throw new NexusError("invalid_argument", `template ${id} has no versions`, { detail: { id } });
    }
    return latest;
  }
}
