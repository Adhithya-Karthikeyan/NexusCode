/**
 * `@nexuscode/cli` — the `nexus` binary (alias `nx`), built on clipanion.
 *
 * clipanion owns command routing, `--help`, and `--version`; each command is a
 * thin shell that captures its remaining argv with `Option.Proxy` and hands it
 * to the shared `parseArgs` + command handler. The headless subcommands share one
 * `UiEvent` projection, so `text` / `json` / `ndjson` are pure renderers over the
 * engine stream. `nexus tui` (and bare `nexus` on a TTY) launches the rich Ink TUI
 * from `@nexuscode/tui` over the same engine; non-TTY invocations print usage.
 */

import { Builtins, Cli, Command, Option } from "clipanion";
import { parseArgs, type FlagSpec, type ParsedArgs } from "./args.js";
import {
  cmdAgent,
  cmdAsk,
  cmdCache,
  cmdChain,
  cmdChat,
  cmdCode,
  cmdCompare,
  cmdConfig,
  cmdConsensus,
  cmdDoctor,
  cmdHistory,
  cmdAuth,
  cmdIndex,
  cmdJobs,
  cmdKeys,
  cmdLogin,
  cmdLogout,
  cmdLsp,
  cmdMcp,
  cmdMemory,
  cmdModels,
  cmdPlan,
  cmdPlugin,
  cmdProviders,
  cmdRace,
  cmdRoute,
  cmdSearch,
  cmdTask,
  cmdTools,
  cmdTui,
} from "./commands.js";
import { cmdServe } from "./serve.js";
import {
  cmdRbac,
  cmdPolicy,
  cmdUsage,
  cmdAudit,
  cmdBudget,
} from "./enterprise-commands.js";
import {
  cmdCommit,
  cmdExplain,
  cmdPr,
  cmdReceipt,
  cmdReplay,
  cmdReview,
  cmdSession,
  cmdTrace,
} from "./wave6.js";

/** Flag grammar shared by every command (parsed from each command's proxied argv). */
const FLAG_SPEC: FlagSpec = {
  value: {
    provider: ["p"],
    model: ["m"],
    output: ["o"],
    system: ["s", "system-prompt"],
    kind: [],
    adapter: [],
    "base-url": [],
    "api-key-ref": [],
    "api-key-env": [],
    value: [],
    tier: [],
    tags: [],
    "max-turns": [],
    "max-steps": [],
    role: ["r"],
    parent: [],
    deps: [],
    cwd: [],
    theme: [],
    preset: [],
    mode: [],
    judge: [],
    strategy: [],
    optimize: [],
    capability: ["cap"],
    stages: [],
    retries: [],
    agent: ["a"],
    transport: [],
    command: [],
    url: [],
    "bearer-ref": [],
    json: [],
    format: ["f"],
    name: [],
    prompt: [],
    title: [],
    base: [],
    line: [],
    character: [],
    port: [],
    host: [],
    // Enterprise (§25) flags.
    principal: [],
    action: [],
    resource: [],
    cost: [],
    window: [],
    from: [],
    to: [],
    limit: [],
    scope: [],
    key: [],
    id: [],
    "on-exceed": [],
    "downgrade-to": [],
    "warn-threshold": [],
    decision: [],
    actor: [],
  },
  multi: {
    backend: ["b"],
    allow: [],
    deny: [],
    fallback: [],
    args: [],
    env: [],
    arg: [],
  },
  bool: {
    help: ["h"],
    tui: [],
    stdin: [],
    tools: ["t"],
    yolo: [],
    approve: [],
    "read-only": [],
    disabled: [],
    verify: [],
    background: ["bg"],
    watch: ["w"],
    // Auth (Wave 13) flags.
    device: [],
    "api-key": [],
    all: [],
    // Opt in to auto-opening a browser to a provider's key page during a
    // guided api-key login (default: off — the URL is printed instead).
    open: [],
  },
};

const USAGE = `nexus — provider-agnostic AI CLI

Usage: nexus <command> [options]

Commands:
  tui                   launch the rich interactive terminal UI (default on a TTY)
  ask <prompt>          one-shot completion (aliases: run, q); reads stdin if piped
  agent <prompt>        agentic run: native tool loop, or OODA framework with --role
  plan <objective>      turn an objective into a task plan (planner role)
  task list|add|done|…  manage the durable task plan
  jobs list|run|history background jobs, command history, PTY seam
  tools list|run         list/run the tool framework's tools (web/db/cloud/… groups)
  code <task>           drive a subprocess coding CLI (--agent claude-code | codex)
  chat                  headless line REPL (pipe lines in; works on TERM=dumb)
  compare <prompt>      fan out across -b providers, aligned
  race <prompt>         race -b providers; --mode first (fastest ok) | best (judged)
  consensus <prompt>    fan across -b providers, then reconcile via a judge
  chain <prompt>        run staged (plan→edit→review) with hand-offs (--stages p:m,p:m)
  route explain|test    show/exercise which provider a RouteRule picks (+failover)
  index [path]          build the RAG index + repo map for a project
  search <query>        query the RAG index; show cited chunks
  lsp <op> <file>       code intelligence: definition|references|diagnostics|hover|rename
  cache stats|clear     inspect or clear the response/embedding caches
  memory list|add|get|rm|ingest   inspect and edit durable memory
  mcp add|list|rm|tools|call  inspect MCP servers, discover + call tools
  providers list|add    inspect or add providers
  models [provider]     list ONE provider's models (positional/-p/active default)
  login [provider]      sign in to a provider (browser OAuth / device / guided key)
  logout [provider]     sign out (clear tokens); --all for every provider
  auth status           per-provider sign-in state (method + token expiry)
  keys set|list|test    manage secrets (values are always masked; prefer 'login')
  config get|set|path   read/write configuration
  history list|show     inspect the SQLite run timeline
  session list|show|…   manage sessions (rename|branch|delete|export json|md|html)
  replay <session>      re-render a recorded session (text; --output ndjson for a TUI)
  receipt <session>     generate the private, local Code Receipt (HTML) for a session
  trace [session|run]   show the span timeline (Gantt) for a run/session
  commit                generate a Conventional Commit message (--approve applies it)
  review                review the current git diff (git diff | nexus review)
  explain               explain a diff / piped input in plain language
  pr                    generate a PR title + description (--base <ref>)
  doctor                verify providers/keys/pipeline + subsystem health
  serve                 start the REST + SSE daemon (--port, --host); prints URL + token
  plugin list|add|…     manage engine-extending plugins

Options:
  -p, --provider <id>     provider (default: config.defaultProvider)
  -m, --model <id>        model id
      --theme <name>      TUI theme (nexus-noir, paper-nexus, solar-flare, neon, midnight, vampire, retro-amber, pastel, frost, matrix, vivid, rose, forest, …)
      --preset <id>       TUI layout preset (chat | agent | compare | dashboard)
  -o, --output <mode>     text | json | ndjson (default: text)
  -b, --backend <p[:m]>   compare/race/consensus backend (repeatable)
      --mode <m>          race: first (fastest ok) | best (judged)
      --judge <model>     consensus: judge model hint
      --strategy <s>      consensus: rank | vote | merge (default: merge)
      --stages <p:m,..>   chain: explicit stage spec (default: plan→edit→review over mock)
      --optimize <axis>   route: cost | latency | quality | local | explicit
      --allow/--deny <id> route: gate candidates (repeatable)
      --fallback <id>     route: last-resort candidate chain (repeatable)
      --cap <capability>  route: require chat | vision | code-edit | shell | tools
      --retries <n>       route test: cap same-provider retries before failover
  -s, --system <text>     system prompt
  -a, --agent <id>        code: subprocess coding CLI (claude-code | codex)
      --transport <t>     mcp add: stdio | http | sse
      --command <cmd>     mcp add (stdio): executable to spawn
      --args <arg>        mcp add (stdio): argv for the command (repeatable)
      --env <K=V>         mcp add (stdio): child env (repeatable)
      --url <url>         mcp add (http/sse): endpoint URL
      --bearer-ref <ref>  mcp add (http/sse): SecretStore ref for a bearer token
      --port <n>          serve: bind port (default: ephemeral)
      --host <addr>       serve: bind host (default: 127.0.0.1, loopback-only)
  -t, --tools             enable the agentic tool loop (ask/agent)
  -r, --role <name>       agent/plan: run the OODA framework as a specialized role
      --max-steps <n>     agent/plan: cap OODA iterations (default: role budget)
      --parent <id>       task add: parent task id (subtask)
      --deps <a,b>        task add: dependency task ids (comma-separated)
      --yolo              tool loop: full-access (no approval prompts)
      --approve           tool loop: workspace-write, auto-approve exec/network
      --read-only         tool loop: read-only (default)
      --max-turns <n>     tool loop: cap provider re-invocations (default 8)
      --device            login: use the headless OAuth device-code flow
      --api-key           login: force the guided api-key path (composite providers)
      --all               logout: sign out of every provider
  -h, --help              show this help
`;

type Handler = (a: ParsedArgs) => Promise<number>;

/** Base command: capture everything after the verb, parse it, run a handler. */
abstract class HandlerCommand extends Command {
  rest = Option.Proxy();
  protected abstract handler(): Handler;
  async execute(): Promise<number> {
    const parsed = parseArgs(this.rest, FLAG_SPEC);
    // `-h`/`--help` after the verb (e.g. `nexus ask -h`) must print THIS
    // command's usage and exit 0 — never fall through to the handler (which
    // would run a real completion and spend tokens). `Option.Proxy()` captures
    // the help token before clipanion's builtin handler sees it, so we honor it
    // here from the parsed flags.
    if (parsed.bools.has("help")) {
      this.context.stdout.write(this.cli.usage(this, { detailed: true }));
      return 0;
    }
    return this.handler()(parsed);
  }
}

class AskCommand extends HandlerCommand {
  static override paths = [["ask"], ["run"], ["q"]];
  static override usage = Command.Usage({
    description: "One-shot completion. Reads stdin when no prompt is given.",
  });
  protected handler(): Handler {
    return cmdAsk;
  }
}

class AgentCommand extends HandlerCommand {
  static override paths = [["agent"]];
  static override usage = Command.Usage({
    description: "Agentic run: native tool loop, or the full OODA framework with --role.",
    details:
      "Without --role, runs the fast native tool-execution loop. With --role <coder|reviewer|tester|planner|researcher|architect|doc-writer|security-reviewer|coordinator>, runs the OODA loop (Observe→Reason→Plan→Act→Evaluate→Repeat): plan drafting, reflection, retry/self-correction, and dynamic replanning — all on the engine bus. --max-steps caps OODA iterations.",
    examples: [
      ["Native tool loop", "nexus agent -p mock -m mock-tools 'read the config'"],
      ["OODA coder role", "nexus agent --role coder --max-steps 4 -p mock -m mock-tools 'add a hello function'"],
    ],
  });
  protected handler(): Handler {
    return cmdAgent;
  }
}

class PlanCommand extends HandlerCommand {
  static override paths = [["plan"]];
  static override usage = Command.Usage({
    description: "Turn an objective into a verifiable, dependency-ordered task plan (planner role).",
    examples: [["Plan a feature", "nexus plan -p mock -m mock-tools 'build a login page'"]],
  });
  protected handler(): Handler {
    return cmdPlan;
  }
}

class TaskCommand extends HandlerCommand {
  static override paths = [["task"], ["tasks"]];
  static override usage = Command.Usage({
    description: "Manage the durable task plan: list | add | start | done | block | cancel | rm | show | clear.",
    examples: [
      ["Add a task", "nexus task add 'write tests'"],
      ["List tasks", "nexus task list"],
      ["Mark done", "nexus task done <id>"],
    ],
  });
  protected handler(): Handler {
    return cmdTask;
  }
}

class JobsCommand extends HandlerCommand {
  static override paths = [["jobs"]];
  static override usage = Command.Usage({
    description: "Terminal integration: list | run | history | pty (background jobs + command history).",
    examples: [
      ["List background jobs", "nexus jobs"],
      ["Run a command as a job", "nexus jobs run -- echo hello"],
      ["Recent command history", "nexus jobs history"],
    ],
  });
  protected handler(): Handler {
    return cmdJobs;
  }
}

class ToolsCommand extends HandlerCommand {
  static override paths = [["tools"]];
  static override usage = Command.Usage({
    description: "List registered tools (grouped, with permission + integration availability) or run one directly.",
    details:
      "`tools list` shows every tool group (web/browser/db/cloud/containers/ai), each tool's permission class, whether the group is enabled in config.tools.enabledGroups, and whether its optional integration (playwright, pg, docker, …) is detected. `tools run <tool> --args '<json>'` invokes one tool under the PermissionGate — a network/write tool needs --approve/--yolo (or an allowlist entry) outside full-access. A tool from a group that isn't enabled is not runnable until you enable it.",
    examples: [
      ["List all tools grouped", "nexus tools list"],
      ["Run a read-class db tool", "nexus tools run db_schema --args '{\"connection\":{\"driver\":\"sqlite\",\"file\":\"app.db\"}}'"],
      ["Run a network tool (approved)", "nexus tools run web_fetch --approve --args '{\"url\":\"https://example.com\"}'"],
    ],
  });
  protected handler(): Handler {
    return cmdTools;
  }
}

class CodeCommand extends HandlerCommand {
  static override paths = [["code"]];
  static override usage = Command.Usage({
    description: "Drive a subprocess coding CLI (claude-code / codex) through the engine.",
    details:
      "Runs a wrapped coding agent that edits files and runs shells; its file-edit/tool-result/approval events stream as UiEvents (diffs + tool activity on stderr). Degrades with a clear message when the CLI is not installed.",
    examples: [
      ["Run Claude Code on a task", "nexus code --agent claude-code 'fix the failing test'"],
      ["Run Codex", "nexus code -a codex 'add a README'"],
    ],
  });
  protected handler(): Handler {
    return cmdCode;
  }
}

class ChatCommand extends HandlerCommand {
  static override paths = [["chat"]];
  static override usage = Command.Usage({ description: "Headless line REPL over the engine." });
  protected handler(): Handler {
    return cmdChat;
  }
}

class McpCommand extends HandlerCommand {
  static override paths = [["mcp"]];
  static override usage = Command.Usage({
    description: "Declare, list, remove, and discover tools from MCP servers.",
    examples: [
      ["Add a known server by name", "nexus mcp add kyp-mem"],
      ["Add a stdio server", "nexus mcp add fs --transport stdio --command npx --args -y --args @modelcontextprotocol/server-filesystem"],
      ["Add a remote server", "nexus mcp add gh --transport http --url https://mcp.example.com --bearer-ref gh-mcp"],
      ["List discovered tools", "nexus mcp tools"],
      ["Call a tool directly", "nexus mcp call kyp-mem kyp_stats"],
    ],
  });
  protected handler(): Handler {
    return cmdMcp;
  }
}

class TuiCommand extends HandlerCommand {
  static override paths = [["tui"]];
  static override usage = Command.Usage({
    description:
      "Launch the rich interactive terminal UI with --theme/--preset (falls back to linear on a non-TTY).",
    details:
      "Options: --theme <name> (nexus-noir, paper-nexus, solar-flare, glacier, contrast-max, synthwave-grid, neon, midnight, vampire, retro-amber, pastel, frost, matrix, vivid, rose, forest), --preset <id> (chat | agent | compare | dashboard). Falls back to linear mode on a non-TTY / TERM=dumb terminal.",
    examples: [
      ["Launch with a theme", "nexus tui --theme nexus-noir"],
      ["Launch a compare preset", "nexus tui --preset compare"],
    ],
  });
  protected handler(): Handler {
    return cmdTui;
  }
}

class MemoryCommand extends HandlerCommand {
  static override paths = [["memory"]];
  static override usage = Command.Usage({ description: "Inspect and edit durable memory." });
  protected handler(): Handler {
    return cmdMemory;
  }
}

class CompareCommand extends HandlerCommand {
  static override paths = [["compare"]];
  static override usage = Command.Usage({ description: "Fan a prompt out across -b providers." });
  protected handler(): Handler {
    return cmdCompare;
  }
}

class RaceCommand extends HandlerCommand {
  static override paths = [["race"]];
  static override usage = Command.Usage({
    description: "Race -b providers; --mode first (fastest ok, cancels losers) | best (judge-ranked).",
    examples: [
      ["Fastest healthy answer", "nexus race -b mock -b mock:mock-smart hi"],
      ["Judge-ranked best", "nexus race --mode best -b mock -b mock:mock-smart hi"],
    ],
  });
  protected handler(): Handler {
    return cmdRace;
  }
}

class ConsensusCommand extends HandlerCommand {
  static override paths = [["consensus"]];
  static override usage = Command.Usage({
    description: "Fan across -b providers, then reconcile them into one answer via a judge.",
    examples: [["Reconcile two lanes", "nexus consensus -b mock -b mock:mock-smart hi"]],
  });
  protected handler(): Handler {
    return cmdConsensus;
  }
}

class ChainCommand extends HandlerCommand {
  static override paths = [["chain"]];
  static override usage = Command.Usage({
    description: "Run staged with hand-offs. Default preset plan→edit→review over mock; override with --stages.",
    examples: [
      ["Default preset over mock", "nexus chain 'build a todo app'"],
      ["Explicit stages", "nexus chain --stages mock:mock-fast,mock:mock-smart 'plan then write'"],
    ],
  });
  protected handler(): Handler {
    return cmdChain;
  }
}

class RouteCommand extends HandlerCommand {
  static override paths = [["route"]];
  static override usage = Command.Usage({
    description: "Show (explain) or exercise (test) which provider a RouteRule picks, with live failover.",
    examples: [
      ["Explain the cheapest pick", "nexus route explain --optimize cost"],
      ["Test a routed run", "nexus route test --optimize local hi"],
      ["Force a failover", "nexus route test --optimize explicit --allow mock-flaky/mock-fast --allow mock/mock-fast --retries 1 hi"],
    ],
  });
  protected handler(): Handler {
    return cmdRoute;
  }
}

class ProvidersCommand extends HandlerCommand {
  static override paths = [["providers"]];
  static override usage = Command.Usage({ description: "List or add providers." });
  protected handler(): Handler {
    return cmdProviders;
  }
}

class ModelsCommand extends HandlerCommand {
  static override paths = [["models"]];
  static override usage = Command.Usage({
    description: "List the models for ONE provider (positional, -p, else the active default) — live from the provider, curated fallback.",
    examples: [
      ["List the active provider's models", "nexus models"],
      ["List one provider's models", "nexus models mock"],
      ["Scope by flag", "nexus models -p mock"],
      ["JSON for scripting", "nexus models mock -o json"],
    ],
  });
  protected handler(): Handler {
    return cmdModels;
  }
}

class KeysCommand extends HandlerCommand {
  static override paths = [["keys"]];
  static override usage = Command.Usage({ description: "Manage secrets (values always masked). Prefer `nexus login`." });
  protected handler(): Handler {
    return cmdKeys;
  }
}

class LoginCommand extends HandlerCommand {
  static override paths = [["login"]];
  static override usage = Command.Usage({
    description: "Sign in to a provider with its REAL auth flow (browser OAuth / device code / vendor CLI / guided key).",
    details:
      "Runs the right honest flow per provider: a real OAuth 2.0 Authorization Code + PKCE browser (loopback) flow where the provider offers OAuth (e.g. Anthropic 'login like Claude Code'), `--device` for a headless device-code flow, a delegate to a wrapped vendor CLI's own login (claude-code / codex / gemini-cli), a cloud-SSO delegate (bedrock), or a guided API-key capture where the provider authenticates by key (OpenAI). Tokens are stored securely via the SecretStore and NEVER printed. With no provider, prompts to pick one. `--api-key` forces the guided key path for a composite provider (Anthropic); `--open` additionally auto-opens a browser to the key page during that guided login (default: off, the URL is just printed). `--device` only works for a provider with a REAL device-code endpoint (currently the Google-backed providers, e.g. `gemini`/`vertex`) — every other provider (including Anthropic, which has no device endpoint, and any api-key / cli-delegate / cloud-sso provider) rejects `--device` with a clear error instead of attempting a flow that doesn't exist; use the plain `nexus login <provider>` form there. Anthropic (Claude) specifically: the account OAuth browser flow (`nexus login anthropic`) is EXPERIMENTAL — Anthropic may change its endpoints without notice. The most reliable Claude auth path is to reuse an existing Claude Code CLI session via `-p claude-code` (no login needed if `claude` is installed and logged in), or run `nexus login anthropic --api-key` for a stable API key.",
    examples: [
      ["Sign in to Anthropic (browser OAuth, experimental)", "nexus login anthropic"],
      ["Reliable Claude auth: reuse an existing Claude Code CLI session", "nexus ask -p claude-code \"hi\""],
      ["Reliable Claude auth: a stable console API key", "nexus login anthropic --api-key"],
      ["Headless device-code flow (Google-backed provider)", "nexus login gemini --device"],
      ["Guided API key (OpenAI)", "nexus login openai"],
      ["Pick a provider interactively", "nexus login"],
    ],
  });
  protected handler(): Handler {
    return cmdLogin;
  }
}

class LogoutCommand extends HandlerCommand {
  static override paths = [["logout"]];
  static override usage = Command.Usage({
    description: "Sign out of a provider (clear stored tokens); `--all` for every provider.",
    examples: [
      ["Sign out of one provider", "nexus logout anthropic"],
      ["Sign out of everything", "nexus logout --all"],
    ],
  });
  protected handler(): Handler {
    return cmdLogout;
  }
}

class AuthCommand extends HandlerCommand {
  static override paths = [["auth"]];
  static override usage = Command.Usage({
    description: "Show per-provider sign-in state: logged in?, method (oauth/api-key/cli/cloud-sso), token expiry.",
    examples: [
      ["Show auth status", "nexus auth status"],
      ["JSON for scripting", "nexus auth status --output json"],
    ],
  });
  protected handler(): Handler {
    return cmdAuth;
  }
}

class ConfigCommand extends HandlerCommand {
  static override paths = [["config"]];
  static override usage = Command.Usage({ description: "Read/write configuration." });
  protected handler(): Handler {
    return cmdConfig;
  }
}

class HistoryCommand extends HandlerCommand {
  static override paths = [["history"]];
  static override usage = Command.Usage({ description: "Inspect the SQLite run timeline." });
  protected handler(): Handler {
    return cmdHistory;
  }
}

class DoctorCommand extends HandlerCommand {
  static override paths = [["doctor"]];
  static override usage = Command.Usage({ description: "Verify providers/keys/pipeline health." });
  protected handler(): Handler {
    return cmdDoctor;
  }
}

class ServeCommand extends HandlerCommand {
  static override paths = [["serve"]];
  static override usage = Command.Usage({
    description: "Start the REST + SSE daemon (@nexuscode/server) over the same engine.",
    details:
      "Embeds one @nexuscode/sdk Nexus (a client of the single engine the CLI drives) and serves it over HTTP + Server-Sent Events. Bearer-token auth on every data route; bound to 127.0.0.1 by default; GET /v1/health is public. Prints the URL + bearer token on startup and stays up until Ctrl+C.",
    examples: [
      ["Serve on an ephemeral port (loopback)", "nexus serve"],
      ["Serve on a fixed port", "nexus serve --port 8787"],
    ],
  });
  protected handler(): Handler {
    return cmdServe;
  }
}

class PluginCommand extends HandlerCommand {
  static override paths = [["plugin"], ["plugins"]];
  static override usage = Command.Usage({
    description: "Manage engine-extending plugins: list | add | remove | info.",
    details:
      "Plugins contribute providers/tools/commands/prompts/mcp-servers/ui-panels into the SAME engine registries the builtins use (sandboxed + version-gated). `list`/`info` discover and report; `add`/`remove` manage the plugin search directories in user config.",
    examples: [
      ["List discovered plugins", "nexus plugin list"],
      ["Add a search directory", "nexus plugin add ./my-plugins"],
      ["Inspect one plugin", "nexus plugin info nexuscode-plugin-acme"],
    ],
  });
  protected handler(): Handler {
    return cmdPlugin;
  }
}

class IndexCommand extends HandlerCommand {
  static override paths = [["index"]];
  static override usage = Command.Usage({
    description: "Build the RAG index + repo map for a project directory (--watch incremental, --background detached).",
    examples: [
      ["Index the current dir", "nexus index"],
      ["Index a specific dir", "nexus index ./src"],
      ["Incremental watch mode", "nexus index --watch"],
      ["Detached background index", "nexus index --background"],
    ],
  });
  protected handler(): Handler {
    return cmdIndex;
  }
}

class SearchCommand extends HandlerCommand {
  static override paths = [["search"]];
  static override usage = Command.Usage({
    description: "Query the RAG index and show cited chunks.",
    examples: [["Search the index", "nexus search 'how does routing work'"]],
  });
  protected handler(): Handler {
    return cmdSearch;
  }
}

class LspCommand extends HandlerCommand {
  static override paths = [["lsp"]];
  static override usage = Command.Usage({
    description: "Code intelligence over LSP: definition | references | diagnostics | hover | rename.",
    details:
      "Drives a language server for the file's language (goto-definition, find-references, diagnostics, hover, rename). Degrades gracefully with a clear message when no server is installed — never a crash. Positions are 0-based (--line, --character); rename takes --name.",
    examples: [
      ["Goto definition", "nexus lsp definition src/index.ts --line 10 --character 4"],
      ["Find references", "nexus lsp references src/index.ts --line 10 --character 4"],
      ["File diagnostics", "nexus lsp diagnostics src/index.ts"],
    ],
  });
  protected handler(): Handler {
    return cmdLsp;
  }
}

class CacheCommand extends HandlerCommand {
  static override paths = [["cache"]];
  static override usage = Command.Usage({
    description: "Inspect (stats) or clear the response/embedding caches.",
    examples: [
      ["Show cache stats", "nexus cache stats"],
      ["Clear the caches", "nexus cache clear"],
    ],
  });
  protected handler(): Handler {
    return cmdCache;
  }
}

class SessionCommand extends HandlerCommand {
  static override paths = [["session"]];
  static override usage = Command.Usage({
    description: "Manage sessions over the event_log: list|show|rename|branch|delete|export.",
    examples: [
      ["List sessions", "nexus session list"],
      ["Export as HTML", "nexus session export <id> --format html -o session.html"],
      ["Branch a session", "nexus session branch <id> --name experiment"],
    ],
  });
  protected handler(): Handler {
    return cmdSession;
  }
}

class ReplayCommand extends HandlerCommand {
  static override paths = [["replay"]];
  static override usage = Command.Usage({
    description: "Re-render a recorded session's timeline (text; --output ndjson feeds a TUI).",
    examples: [["Replay a session", "nexus replay <sessionId>"]],
  });
  protected handler(): Handler {
    return cmdReplay;
  }
}

class ReceiptCommand extends HandlerCommand {
  static override paths = [["receipt"]];
  static override usage = Command.Usage({
    description: "Generate the private, redaction-safe Code Receipt (local HTML) for a session.",
    details:
      "Renders one coding session (prompt → diff → passing tests) into a self-contained local HTML file and prints its path. Private by default — never uploaded or shared.",
    examples: [
      ["Default temp path", "nexus receipt <sessionId>"],
      ["Explicit output file", "nexus receipt <sessionId> -o ./receipt.html"],
    ],
  });
  protected handler(): Handler {
    return cmdReceipt;
  }
}

class TraceCommand extends HandlerCommand {
  static override paths = [["trace"]];
  static override usage = Command.Usage({
    description: "Show the span timeline (Gantt) for a run/session/trace from the trace sink.",
    examples: [
      ["All recorded traces", "nexus trace"],
      ["A specific session's spans", "nexus trace <sessionId>"],
    ],
  });
  protected handler(): Handler {
    return cmdTrace;
  }
}

class CommitCommand extends HandlerCommand {
  static override paths = [["commit"]];
  static override usage = Command.Usage({
    description: "Generate a Conventional Commit message from the staged diff (--approve applies it).",
    examples: [
      ["Generate a message", "nexus commit"],
      ["Generate and apply", "nexus commit --approve"],
    ],
  });
  protected handler(): Handler {
    return cmdCommit;
  }
}

class ReviewCommand extends HandlerCommand {
  static override paths = [["review"]];
  static override usage = Command.Usage({
    description: "Review the current git diff (supports `git diff | nexus review`).",
    examples: [
      ["Review the working tree", "nexus review"],
      ["Review a piped diff", "git diff | nexus review"],
    ],
  });
  protected handler(): Handler {
    return cmdReview;
  }
}

class ExplainCommand extends HandlerCommand {
  static override paths = [["explain"]];
  static override usage = Command.Usage({
    description: "Explain a diff in plain language (supports `git diff | nexus explain`).",
    examples: [["Explain a piped diff", "git diff | nexus explain"]],
  });
  protected handler(): Handler {
    return cmdExplain;
  }
}

class PrCommand extends HandlerCommand {
  static override paths = [["pr"]];
  static override usage = Command.Usage({
    description: "Generate a PR title + description from commits/diff (--base <ref> to scope).",
    examples: [
      ["Describe changes vs main", "nexus pr --base main"],
      ["From a piped diff", "git diff main...HEAD | nexus pr"],
    ],
  });
  protected handler(): Handler {
    return cmdPr;
  }
}

class RbacCommand extends HandlerCommand {
  static override paths = [["rbac"]];
  static override usage = Command.Usage({
    description: "Enterprise RBAC: list roles/grants/principals or check a permission.",
    details:
      "`rbac list` shows the built-in + custom roles, their grants, and the principal directory. `rbac check --principal <id> --action <verb> --resource <type:id>` runs the fail-closed RBAC+policy authorizer and prints ALLOW/DENY with the deciding source + reason (exit 1 on deny).",
    examples: [
      ["List roles + principals", "nexus rbac list"],
      ["Check a write on a tool", "nexus rbac check --principal alice --action write --resource tool:fs_write"],
    ],
  });
  protected handler(): Handler {
    return cmdRbac;
  }
}

class PolicyCommand extends HandlerCommand {
  static override paths = [["policy"]];
  static override usage = Command.Usage({
    description: "Enterprise policy engine: list deny-overrides rules or test one.",
    details:
      "`policy list` prints the declarative rule set (deny-overrides, fail-closed). `policy test --principal <id> --action <a> --resource <r> [--cost <usd>]` evaluates the combined RBAC+policy decision and shows the matched rule.",
    examples: [
      ["List policies", "nexus policy list"],
      ["Test with a cost cap", "nexus policy test --principal bob --action use --resource model:gpt-4o --cost 2.50"],
    ],
  });
  protected handler(): Handler {
    return cmdPolicy;
  }
}

class UsageCommand extends HandlerCommand {
  static override paths = [["usage"]];
  static override usage = Command.Usage({
    description: "Enterprise usage analytics: cost/token report over the run history.",
    details:
      "Aggregates the run history's usage + cost per provider/model over a day/week/month window, with CSV/JSON export. `--window`, `--provider`, `--model`, `--from`/`--to` filter; `--format csv` or `--output json` export.",
    examples: [
      ["Daily usage report", "nexus usage --window day"],
      ["Export CSV", "nexus usage --window month --format csv"],
    ],
  });
  protected handler(): Handler {
    return cmdUsage;
  }
}

class AuditCommand extends HandlerCommand {
  static override paths = [["audit"]];
  static override usage = Command.Usage({
    description: "Enterprise audit log: query the append-only chain or verify its integrity.",
    details:
      "The audit log is append-only, redacted, and hash-chained. `audit` queries it (`--actor`/`--action`/`--decision`/`--limit`). `audit --verify` recomputes the chain from disk and reports any tamper (exit 1 when tampered).",
    examples: [
      ["Recent decisions", "nexus audit --limit 20"],
      ["Verify the chain", "nexus audit --verify"],
    ],
  });
  protected handler(): Handler {
    return cmdAudit;
  }
}

class BudgetCommand extends HandlerCommand {
  static override paths = [["budget"], ["budgets"]];
  static override usage = Command.Usage({
    description: "Enterprise cost controls: show budgets + spend, or set a budget.",
    details:
      "`budget show` lists configured budgets with live spend/remaining (seeded from the run history). `budget set --id <id> --scope <principal|role|org> --key <k> --limit <usd> --window <run|day|month>` writes a budget to user config.",
    examples: [
      ["Show budgets + spend", "nexus budget show"],
      ["Set a monthly org cap", "nexus budget set --id org-cap --scope org --key acme --limit 500 --window month"],
    ],
  });
  protected handler(): Handler {
    return cmdBudget;
  }
}

/**
 * Bare `nexus` (with or without run flags): the default entry point IS the TUI.
 * It captures its argv with `Option.Proxy` (exactly like every run-capable
 * command) so `nexus -p mock`, `nexus -p claude-code`, `nexus --theme …`,
 * `nexus --preset …` are ACCEPTED — the same flag grammar `tui`/`ask` accept —
 * instead of erroring with "Unsupported option name (-p)".
 *
 * Launch the TUI when stdout is a TTY, OR when the user passed any run flags/args
 * (so `nexus -p mock` on a non-TTY reaches the TUI's linear-mode fallback rather
 * than the usage screen). A truly bare, non-TTY `nexus` (piped/redirected/CI with
 * no args) prints usage. `cmdTui` degrades further to a linear fallback for
 * `TERM=dumb` / too-narrow terminals — it never crashes.
 */
class DefaultCommand extends Command {
  static override paths = [Command.Default];
  rest = Option.Proxy();
  async execute(): Promise<number> {
    // A bare, non-flag FIRST token reached the Default command only because
    // clipanion could not match it to any registered command path — i.e. it is a
    // mistyped/unknown command (e.g. `nexus git review`). Fail with a clear,
    // human-readable message instead of silently launching the TUI's linear
    // fallback and dropping the words (the old confusing behavior). Flags-only
    // invocations (`nexus -p mock`, `nexus --theme … --preset …`) and a truly
    // bare `nexus` still launch the TUI exactly as before.
    const first = this.rest[0];
    if (first !== undefined && first !== "--" && !first.startsWith("-")) {
      let hint = "run `nexus --help` for the command list";
      if (first === "git") {
        // `nexus git review` / `nexus git diff …` mimic git subcommands — point
        // at the real top-level nexus commands that consume a git diff.
        hint = "did you mean `nexus review` / `nexus explain` / `nexus pr`? (e.g. `git diff | nexus review`)";
      }
      this.context.stderr.write(`nexus: unknown command "${first}" — ${hint}\n`);
      return 1;
    }
    const args = parseArgs(this.rest, FLAG_SPEC);
    if (process.stdout.isTTY || this.rest.length > 0) {
      return cmdTui(args);
    }
    this.context.stdout.write(USAGE);
    return 0;
  }
}

const cli = new Cli({
  binaryLabel: "NexusCode",
  binaryName: "nexus",
  binaryVersion: "0.0.0",
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.register(DefaultCommand);
cli.register(TuiCommand);
cli.register(AskCommand);
cli.register(AgentCommand);
cli.register(PlanCommand);
cli.register(TaskCommand);
cli.register(JobsCommand);
cli.register(ToolsCommand);
cli.register(CodeCommand);
cli.register(ChatCommand);
cli.register(McpCommand);
cli.register(CompareCommand);
cli.register(RaceCommand);
cli.register(ConsensusCommand);
cli.register(ChainCommand);
cli.register(RouteCommand);
cli.register(MemoryCommand);
cli.register(ProvidersCommand);
cli.register(ModelsCommand);
cli.register(LoginCommand);
cli.register(LogoutCommand);
cli.register(AuthCommand);
cli.register(KeysCommand);
cli.register(ConfigCommand);
cli.register(HistoryCommand);
cli.register(DoctorCommand);
cli.register(ServeCommand);
cli.register(PluginCommand);
cli.register(IndexCommand);
cli.register(SearchCommand);
cli.register(LspCommand);
cli.register(CacheCommand);
cli.register(SessionCommand);
cli.register(ReplayCommand);
cli.register(ReceiptCommand);
cli.register(TraceCommand);
cli.register(CommitCommand);
cli.register(ReviewCommand);
cli.register(ExplainCommand);
cli.register(PrCommand);
cli.register(RbacCommand);
cli.register(PolicyCommand);
cli.register(UsageCommand);
cli.register(AuditCommand);
cli.register(BudgetCommand);

void cli.runExit(process.argv.slice(2));
