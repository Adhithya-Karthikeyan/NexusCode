/**
 * Language detection (system-spec §11) — resolve a source language from a file
 * path first (extension + a few special basenames), then fall back to a shebang
 * line, then to lightweight content heuristics. Detection is deterministic and
 * dependency-free so it runs identically offline and in tests.
 */

/** Languages the file-intelligence layer understands. `unknown` is the sink. */
export type Lang =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "shell"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "html"
  | "css"
  | "sql"
  | "unknown";

/** Language ids for which the heuristic parser extracts symbols/imports. */
export const PARSEABLE_LANGS: readonly Lang[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "go",
] as const;

/** How a language was decided — useful for confidence and debugging. */
export type DetectMethod = "extension" | "basename" | "shebang" | "content" | "default";

export interface Detection {
  lang: Lang;
  method: DetectMethod;
}

/** Extension → language. Lowercased, without the leading dot. */
const EXT_TABLE: Record<string, Lang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  sql: "sql",
};

/** Exact basenames that pin a language regardless of (missing) extension. */
const BASENAME_TABLE: Record<string, Lang> = {
  dockerfile: "shell",
  makefile: "shell",
  gemfile: "ruby",
  rakefile: "ruby",
};

/** Interpreter token found in a shebang → language. */
const SHEBANG_TABLE: Array<[RegExp, Lang]> = [
  [/\bpython[0-9.]*\b/, "python"],
  [/\bnode\b/, "javascript"],
  [/\b(bash|sh|zsh|dash)\b/, "shell"],
  [/\bruby\b/, "ruby"],
  [/\bphp\b/, "php"],
];

function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function basenameOf(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase();
}

/** Detect via `#!` interpreter line. Returns `undefined` when absent/unknown. */
export function detectFromShebang(content: string): Lang | undefined {
  if (!content.startsWith("#!")) return undefined;
  const firstLine = content.slice(0, content.indexOf("\n") === -1 ? undefined : content.indexOf("\n"));
  for (const [re, lang] of SHEBANG_TABLE) {
    if (re.test(firstLine)) return lang;
  }
  return undefined;
}

/** Very small content sniffer used only when path + shebang are inconclusive. */
export function detectFromContent(content: string): Lang | undefined {
  const head = content.slice(0, 4096);
  if (/^\s*<\?php\b/.test(head)) return "php";
  if (/^\s*<(!doctype html|html)\b/i.test(head)) return "html";
  if (/^\s*package\s+main\b/m.test(head) && /\bfunc\s+\w+\s*\(/.test(head)) return "go";
  if (/^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+)/m.test(head) && /:\s*$/m.test(head)) {
    return "python";
  }
  if (/^\s*def\s+\w+\s*\(/m.test(head) && /:\s*$/m.test(head)) return "python";
  if (/\b(interface|type)\s+\w+|:\s*(string|number|boolean)\b/.test(head)) return "typescript";
  if (/\b(const|let|var|function)\b/.test(head) && /=>|function\s*\(/.test(head)) return "javascript";
  // JSON: a lone object/array literal.
  const trimmed = head.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(content);
      return "json";
    } catch {
      // not valid JSON — ignore.
    }
  }
  return undefined;
}

/**
 * Detect the language of a file. `content` is optional; when supplied it enables
 * shebang and content fallbacks for extensionless or ambiguous files.
 */
export function detectDetailed(filePath: string, content?: string): Detection {
  const ext = extensionOf(filePath);
  if (ext && EXT_TABLE[ext]) return { lang: EXT_TABLE[ext], method: "extension" };

  const base = basenameOf(filePath);
  if (BASENAME_TABLE[base]) return { lang: BASENAME_TABLE[base], method: "basename" };
  // e.g. `Dockerfile.dev` → treat the leading token as the basename key.
  const leading = base.split(".")[0];
  if (leading && BASENAME_TABLE[leading]) return { lang: BASENAME_TABLE[leading], method: "basename" };

  if (content !== undefined) {
    const shebang = detectFromShebang(content);
    if (shebang) return { lang: shebang, method: "shebang" };
    const sniffed = detectFromContent(content);
    if (sniffed) return { lang: sniffed, method: "content" };
  }

  return { lang: "unknown", method: "default" };
}

/** Detect the language of a file, returning just the {@link Lang}. */
export function detectLanguage(filePath: string, content?: string): Lang {
  return detectDetailed(filePath, content).lang;
}

/** Whether the heuristic parser can extract symbols/imports for this language. */
export function isParseable(lang: Lang): boolean {
  return PARSEABLE_LANGS.includes(lang);
}
