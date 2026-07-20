/**
 * HeuristicParser — a robust, dependency-free {@link Parser} that recovers
 * top-level definitions and import specifiers via line-oriented regex scanning.
 * It intentionally trades a little precision for zero build fragility: it never
 * needs a native toolchain, so it runs identically offline and in CI. For full
 * fidelity, swap in the web-tree-sitter seam (see `treesitter.ts`).
 *
 * Coverage: ts / tsx / js / jsx / python / go. Unknown languages yield `[]`.
 */

import type { Lang } from "./language.js";
import type { CodeSymbol, Parser, SymbolKind } from "./parser.js";

const JS_LANGS: ReadonlySet<Lang> = new Set(["typescript", "tsx", "javascript", "jsx"]);

/** Strip line comments and blank runs cheaply; keep line numbers intact. */
function lines(code: string): string[] {
  return code.split(/\r?\n/);
}

function pushUnique(symbols: CodeSymbol[], sym: CodeSymbol): void {
  // De-dupe on name+kind+container (a heuristic may match the same decl twice).
  for (const s of symbols) {
    if (s.name === sym.name && s.kind === sym.kind && s.container === sym.container) return;
  }
  symbols.push(sym);
}

function signatureFrom(line: string): string {
  const trimmed = line.trim();
  const brace = trimmed.indexOf("{");
  const body = brace === -1 ? trimmed : trimmed.slice(0, brace).trim();
  return body.length > 200 ? body.slice(0, 200) + "…" : body;
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript family
// ---------------------------------------------------------------------------

const RE_JS_FUNCTION = /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const RE_JS_CLASS = /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const RE_JS_INTERFACE = /^\s*(export\s+)?(default\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const RE_JS_TYPE = /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)/;
const RE_JS_ENUM = /^\s*(export\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const RE_JS_BINDING = /^\s*(export\s+)?(default\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/;
// A class method: identifier immediately followed by `(`, at class-body indent.
const RE_JS_METHOD =
  /^\s*(public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

const JS_METHOD_SKIP: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "await",
  "do",
]);

function isArrowOrFn(rhs: string): boolean {
  if (/^(async\s+)?function\b/.test(rhs)) return true;
  // Arrow function: a param list (which may carry a return-type annotation) or a
  // single identifier param, followed somewhere by `=>`.
  return /^(async\s+)?(\(|[A-Za-z_$][\w$]*\b)/.test(rhs) && /=>/.test(rhs);
}

function parseJsSymbols(src: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  let classDepth = 0; // brace depth we entered a class at (0 = not in class)
  let depth = 0;
  let className: string | undefined;

  for (let i = 0; i < src.length; i++) {
    const raw = src[i] ?? "";
    const line = raw.replace(/\/\/.*$/, "");
    const lineNo = i + 1;

    const cls = RE_JS_CLASS.exec(line);
    if (cls && cls[4]) {
      pushUnique(symbols, {
        name: cls[4],
        kind: "class",
        line: lineNo,
        exported: Boolean(cls[1] ?? cls[2]),
        signature: signatureFrom(line),
      });
      // If the class body opens on this line, record it.
      if (line.includes("{")) {
        className = cls[4];
        classDepth = depth + 1;
      } else {
        className = cls[4];
        classDepth = -1; // opens on a later line
      }
    }

    if (classDepth === -1 && line.includes("{")) {
      classDepth = depth + 1;
    }

    const fn = RE_JS_FUNCTION.exec(line);
    if (fn && fn[4]) {
      pushUnique(symbols, {
        name: fn[4],
        kind: "function",
        line: lineNo,
        exported: Boolean(fn[1] ?? fn[2]),
        signature: signatureFrom(line),
      });
    }

    const iface = RE_JS_INTERFACE.exec(line);
    if (iface && iface[3]) {
      pushUnique(symbols, {
        name: iface[3],
        kind: "interface",
        line: lineNo,
        exported: Boolean(iface[1]),
        signature: signatureFrom(line),
      });
    }

    const ty = RE_JS_TYPE.exec(line);
    if (ty && ty[2]) {
      pushUnique(symbols, {
        name: ty[2],
        kind: "type",
        line: lineNo,
        exported: Boolean(ty[1]),
        signature: signatureFrom(line),
      });
    }

    const en = RE_JS_ENUM.exec(line);
    if (en && en[3]) {
      pushUnique(symbols, {
        name: en[3],
        kind: "enum",
        line: lineNo,
        exported: Boolean(en[1]),
        signature: signatureFrom(line),
      });
    }

    // Top-level bindings only (depth 0), so we don't grab local consts.
    if (depth === 0) {
      const bind = RE_JS_BINDING.exec(line);
      if (bind && bind[4]) {
        const rhs = (bind[5] ?? "").trim();
        const isFn = isArrowOrFn(rhs);
        pushUnique(symbols, {
          name: bind[4],
          kind: isFn ? "function" : bind[3] === "const" ? "const" : "variable",
          line: lineNo,
          exported: Boolean(bind[1] ?? bind[2]),
          signature: signatureFrom(line),
        });
      }
    }

    // Class methods: only at the class body's own brace depth.
    if (classDepth > 0 && depth === classDepth && className) {
      const m = RE_JS_METHOD.exec(line);
      if (m && m[2] && !JS_METHOD_SKIP.has(m[2]) && !RE_JS_FUNCTION.test(line)) {
        pushUnique(symbols, {
          name: m[2],
          kind: "method",
          line: lineNo,
          exported: true,
          signature: signatureFrom(line),
          container: className,
        });
      }
    }

    // Track brace depth after processing the line (ignoring braces in strings
    // is out of scope for a heuristic; this is good enough for top-level ranking).
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (classDepth > 0 && depth < classDepth) {
          classDepth = 0;
          className = undefined;
        }
      }
    }
  }
  return symbols;
}

const RE_JS_IMPORT_FROM = /\bimport\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const RE_JS_IMPORT_BARE = /\bimport\s*['"]([^'"]+)['"]/g;
const RE_JS_EXPORT_FROM = /\bexport\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const RE_JS_REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_JS_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function parseJsImports(code: string): string[] {
  const out = new Set<string>();
  for (const re of [RE_JS_IMPORT_FROM, RE_JS_EXPORT_FROM, RE_JS_IMPORT_BARE, RE_JS_REQUIRE, RE_JS_DYNAMIC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m[1]) out.add(m[1]);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const RE_PY_DEF = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const RE_PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const RE_PY_CONST = /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=\s*/;

function parsePySymbols(src: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  // Stack of (indent, className) so nested defs attach to the closest class.
  const classStack: Array<{ indent: number; name: string }> = [];

  for (let i = 0; i < src.length; i++) {
    const line = src[i] ?? "";
    const lineNo = i + 1;
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;

    const indent = (line.match(/^\s*/)?.[0] ?? "").length;
    while (classStack.length > 0 && indent <= (classStack[classStack.length - 1]?.indent ?? 0)) {
      classStack.pop();
    }

    const cls = RE_PY_CLASS.exec(line);
    if (cls && cls[2]) {
      pushUnique(symbols, {
        name: cls[2],
        kind: "class",
        line: lineNo,
        exported: !cls[2].startsWith("_"),
        signature: signatureFrom(line.replace(/:\s*$/, "")),
      });
      classStack.push({ indent, name: cls[2] });
      continue;
    }

    const def = RE_PY_DEF.exec(line);
    if (def && def[3]) {
      const container = classStack.length > 0 ? classStack[classStack.length - 1]?.name : undefined;
      pushUnique(symbols, {
        name: def[3],
        kind: container ? "method" : "function",
        line: lineNo,
        exported: !def[3].startsWith("_"),
        signature: signatureFrom(line.replace(/:\s*$/, "")),
        ...(container ? { container } : {}),
      });
      continue;
    }

    if (indent === 0) {
      const con = RE_PY_CONST.exec(line);
      if (con && con[1]) {
        pushUnique(symbols, {
          name: con[1],
          kind: "const",
          line: lineNo,
          exported: true,
          signature: signatureFrom(line),
        });
      }
    }
  }
  return symbols;
}

const RE_PY_FROM = /^\s*from\s+([.\w]+)\s+import\b/gm;
const RE_PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

function parsePyImports(code: string): string[] {
  const out = new Set<string>();
  RE_PY_FROM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PY_FROM.exec(code)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  RE_PY_IMPORT.lastIndex = 0;
  while ((m = RE_PY_IMPORT.exec(code)) !== null) {
    const group = m[1] ?? "";
    for (const part of group.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) out.add(name);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const RE_GO_FUNC = /^\s*func\s+(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/;
const RE_GO_TYPE = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface|[\w.\[\]*]+)/;
const RE_GO_DECL = /^\s*(?:const|var)\s+([A-Za-z_]\w*)\s/;

function goExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function parseGoSymbols(src: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let i = 0; i < src.length; i++) {
    const line = src[i] ?? "";
    const lineNo = i + 1;

    const fn = RE_GO_FUNC.exec(line);
    if (fn && fn[2]) {
      const receiver = fn[1];
      pushUnique(symbols, {
        name: fn[2],
        kind: receiver ? "method" : "function",
        line: lineNo,
        exported: goExported(fn[2]),
        signature: signatureFrom(line),
        ...(receiver ? { container: receiver } : {}),
      });
      continue;
    }

    const ty = RE_GO_TYPE.exec(line);
    if (ty && ty[1]) {
      pushUnique(symbols, {
        name: ty[1],
        kind: ty[2] === "struct" ? "struct" : ty[2] === "interface" ? "interface" : "type",
        line: lineNo,
        exported: goExported(ty[1]),
        signature: signatureFrom(line),
      });
      continue;
    }

    const decl = RE_GO_DECL.exec(line);
    if (decl && decl[1]) {
      pushUnique(symbols, {
        name: decl[1],
        kind: "const",
        line: lineNo,
        exported: goExported(decl[1]),
        signature: signatureFrom(line),
      });
    }
  }
  return symbols;
}

const RE_GO_IMPORT_SINGLE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const RE_GO_IMPORT_BLOCK_LINE = /^\s*(?:[\w.]+\s+)?"([^"]+)"\s*$/gm;

function parseGoImports(code: string): string[] {
  const out = new Set<string>();
  RE_GO_IMPORT_SINGLE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_GO_IMPORT_SINGLE.exec(code)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  // Grab quoted lines inside `import ( ... )` blocks.
  const blocks = code.match(/import\s*\(([\s\S]*?)\)/g) ?? [];
  for (const block of blocks) {
    RE_GO_IMPORT_BLOCK_LINE.lastIndex = 0;
    while ((m = RE_GO_IMPORT_BLOCK_LINE.exec(block)) !== null) {
      if (m[1]) out.add(m[1]);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------

/** The shipped, dependency-free parser. Stateless and safe to share. */
export class HeuristicParser implements Parser {
  symbols(code: string, lang: Lang): CodeSymbol[] {
    if (JS_LANGS.has(lang)) return parseJsSymbols(lines(code));
    if (lang === "python") return parsePySymbols(lines(code));
    if (lang === "go") return parseGoSymbols(lines(code));
    return [];
  }

  imports(code: string, lang: Lang): string[] {
    if (JS_LANGS.has(lang)) return parseJsImports(code);
    if (lang === "python") return parsePyImports(code);
    if (lang === "go") return parseGoImports(code);
    return [];
  }
}

/** A ready-to-use shared instance. */
export const heuristicParser: Parser = new HeuristicParser();

/** Exported for callers that want the JS symbol kinds map (docs/tests). */
export type { SymbolKind };
