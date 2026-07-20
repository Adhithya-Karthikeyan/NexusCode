# NexusCode Command Reference

Complete reference for every `nexus` command, subcommand, and flag.

- [Invoking the CLI](#invoking-the-cli)
- [Global flags](#global-flags)
- [Quick reference](#quick-reference)
- [Command details](#command-details)

---

## Invoking the CLI

The CLI installs a single binary, `nexus`:

```bash
nexus <command> [options]
```

Running `nexus` with no arguments launches the interactive TUI when stdout is a
terminal. On a non-TTY (piped, redirected, CI) a bare `nexus` prints the usage
screen instead. Flags-only invocations such as `nexus -p mock` still reach the
TUI, which falls back to linear mode when it cannot mount.

```bash
nexus                       # TUI on a TTY, usage screen otherwise
nexus --help                # top-level command list
nexus <command> --help      # detailed help for one command
nexus --version             # print the version
```

### Trying it offline

Every example marked with `-p mock` runs entirely offline against the built-in
`mock` provider — no API key, no network. That is the fastest way to explore the
CLI before signing in. The mock provider ships the models `mock-fast`,
`mock-smart`, and `mock-tools` (the last one supports the tool loop).

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime failure (provider unavailable, denied, nothing found, tampered chain) |
| `2` | Usage error (missing prompt, unknown subcommand, bad flag combination) |

---

## Global flags

NexusCode parses one shared flag grammar for every command, so these spellings
work anywhere they are meaningful. A flag a command does not use is ignored, and
an unrecognized flag prints a `did you mean …?` warning rather than failing.

| Flag | Alias | Description |
| --- | --- | --- |
| `--help` | `-h` | Print the command's detailed help and exit 0 |
| `--output <mode>` | `-o` | `text` (default), `json`, or `ndjson` |
| `--provider <id>` | `-p` | Provider to run against (default: `config.defaultProvider`) |
| `--model <id>` | `-m` | Model id (default: the config default, else the provider's first model) |
| `--system <text>` | `-s`, `--system-prompt` | Override the system prompt |
| `--cwd <dir>` | | Working directory for tool, git, and job execution |

Notes:

- Values accept both `--flag value` and `--flag=value`.
- Everything after a bare `--` is treated as a positional argument.
- Repeatable flags (`-b`, `--allow`, `--deny`, `--fallback`, `--args`, `--env`,
  `--arg`) accumulate; single-value flags keep the last occurrence.
- Most commands read piped stdin when no positional prompt is given, so
  `git diff | nexus review` and `echo 'hi' | nexus ask` both work.

### Permission flags

Commands that execute tools (`ask --tools`, `agent`, `tools run`, `commit`)
share one permission model. The default is always the safest option.

| Flag | Mode | Effect |
| --- | --- | --- |
| `--read-only` | `read-only` | Default. No writes, no exec, no network from tools |
| `--approve` | `workspace-write` | Auto-approve writes, exec, and network inside the workspace |
| `--yolo` | `full-access` | No approval prompts at all |

---

## Quick reference

### Core

| Command | Description |
| --- | --- |
| [`tui`](#nexus-tui) | Launch the rich interactive terminal UI |
| [`ask`](#nexus-ask) | One-shot completion (aliases: `run`, `q`) |
| [`agent`](#nexus-agent) | Agentic run: native tool loop, or the OODA framework with `--role` |
| [`chat`](#nexus-chat) | Headless line REPL over the engine |
| [`code`](#nexus-code) | Drive a subprocess coding CLI (claude-code / codex) |
| [`plan`](#nexus-plan) | Turn an objective into a dependency-ordered task plan |
| [`task`](#nexus-task) | Manage the durable task plan (alias: `tasks`) |

### Multi-model orchestration

| Command | Description |
| --- | --- |
| [`compare`](#nexus-compare) | Fan one prompt across several providers, side by side |
| [`race`](#nexus-race) | Race providers; fastest healthy answer or judge-ranked best |
| [`consensus`](#nexus-consensus) | Fan out, then reconcile the answers via a judge |
| [`chain`](#nexus-chain) | Run staged with hand-offs (plan → edit → review) |
| [`route`](#nexus-route) | Explain or exercise which provider a route rule picks |

### Code & Git

| Command | Description |
| --- | --- |
| [`commit`](#nexus-commit) | Generate a Conventional Commit message from the staged diff |
| [`review`](#nexus-review) | Review the current git diff |
| [`explain`](#nexus-explain) | Explain a diff in plain language |
| [`pr`](#nexus-pr) | Generate a PR title and description |
| [`lsp`](#nexus-lsp) | Code intelligence: definition, references, diagnostics, hover, rename |

### Context & Memory

| Command | Description |
| --- | --- |
| [`index`](#nexus-index) | Build the RAG index and repo map for a project |
| [`search`](#nexus-search) | Query the RAG index and show cited chunks |
| [`memory`](#nexus-memory) | Inspect and edit durable memory |
| [`cache`](#nexus-cache) | Inspect or clear the response/embedding caches |

### Tools & Integrations

| Command | Description |
| --- | --- |
| [`tools`](#nexus-tools) | List registered tools or run one directly |
| [`mcp`](#nexus-mcp) | Declare, list, remove, and discover tools from MCP servers |
| [`plugin`](#nexus-plugin) | Manage engine-extending plugins (alias: `plugins`) |
| [`jobs`](#nexus-jobs) | Background jobs, command history, and the PTY seam |
| [`serve`](#nexus-serve) | Start the REST + SSE daemon over the same engine |

### Sessions & Observability

| Command | Description |
| --- | --- |
| [`session`](#nexus-session) | Manage sessions: list, show, rename, branch, delete, export |
| [`replay`](#nexus-replay) | Re-render a recorded session's timeline |
| [`receipt`](#nexus-receipt) | Generate the private, local Code Receipt (HTML) for a session |
| [`trace`](#nexus-trace) | Show the span timeline (Gantt) for a run, session, or trace |
| [`history`](#nexus-history) | Inspect the SQLite run timeline |
| [`doctor`](#nexus-doctor) | Verify providers, keys, and pipeline health |

### Enterprise

| Command | Description |
| --- | --- |
| [`rbac`](#nexus-rbac) | List roles, grants, and principals, or check a permission |
| [`policy`](#nexus-policy) | List deny-overrides policy rules or test one |
| [`usage`](#nexus-usage) | Cost and token analytics over the run history |
| [`audit`](#nexus-audit) | Query the append-only audit chain or verify its integrity |
| [`budget`](#nexus-budget) | Show budgets and spend, or set a budget (alias: `budgets`) |

### Config & Auth

| Command | Description |
| --- | --- |
| [`config`](#nexus-config) | Read and write configuration |
| [`providers`](#nexus-providers) | List or add providers |
| [`models`](#nexus-models) | List the models for one provider |
| [`login`](#nexus-login) | Sign in to a provider with its real auth flow |
| [`logout`](#nexus-logout) | Sign out of a provider |
| [`auth`](#nexus-auth) | Show per-provider sign-in state |
| [`keys`](#nexus-keys) | Manage secrets (values always masked) |

---

## Command details

## Core

### `nexus tui`

Launch the rich interactive terminal UI. This is also what a bare `nexus` runs on
a TTY.

**Usage:** `nexus tui [--theme <name>] [--preset <id>] [-p <provider>] [-m <model>] [-s <text>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--theme <name>` | string | config theme | Colour theme (see list below) |
| `--preset <id>` | enum | `conversation` | Layout preset: `conversation`, `chat`, `agent`, `compare`, `dashboard` |
| `-p, --provider <id>` | string | config default | Provider to start against |
| `-m, --model <id>` | string | provider default | Model to start against |
| `-s, --system <text>` | string | built-in prompt | System prompt |

**Themes:** `nexus-noir`, `paper-nexus`, `solar-flare`, `glacier`,
`contrast-max`, `synthwave-grid`, `neon`, `midnight`, `vampire`, `retro-amber`,
`pastel`, `frost`, `matrix`, `vivid`, `rose`, `forest`.

**Examples**

```bash
nexus tui --theme nexus-noir
nexus tui --preset compare
nexus tui -p mock                  # offline UI, no key needed
```

**Notes:** On a non-TTY, `TERM=dumb`, or a too-narrow terminal, the TUI prints a
one-line linear-mode notice and exits 0 — it never crashes. An explicitly named
provider that is unavailable is a hard error; the default provider degrades
gracefully to an available one. Inside the TUI, `/model` and `/provider` re-point
the next turn against a different target.

---

### `nexus ask`

One-shot completion. Reads stdin when no prompt argument is given.

**Aliases:** `nexus run`, `nexus q`

**Usage:** `nexus ask [prompt...] [-p <provider>] [-m <model>] [-s <text>] [-o <mode>] [-t]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p, --provider <id>` | string | config default | Provider to run against |
| `-m, --model <id>` | string | provider default | Model id |
| `-s, --system <text>` | string | built-in prompt | System prompt |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |
| `-t, --tools` | bool | off | Enable the agentic tool loop (routes to `agent`) |
| `--read-only` | bool | on | Tool loop: read-only (default) |
| `--approve` | bool | off | Tool loop: workspace-write, auto-approve exec/network |
| `--yolo` | bool | off | Tool loop: full access, no approval prompts |

**Examples**

```bash
nexus ask -p mock 'explain what a monorepo is'
echo 'summarize this' | nexus ask -p mock
nexus ask -p mock -o json 'hi'
nexus ask -p claude-code 'hi'      # reuse an existing Claude Code CLI session
```

**Notes:** When the response cache is enabled in config, an identical request
short-circuits the provider call entirely and reports the saved tokens and cost
on stderr. Exits 2 when no prompt is supplied via argument or stdin.

---

### `nexus agent`

Agentic run: the fast native tool-execution loop, or the full OODA framework when
you pass `--role`.

**Usage:** `nexus agent <prompt...> [--role <name>] [--max-steps <n>] [--max-turns <n>] [-p <provider>] [-m <model>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-r, --role <name>` | string | none | Run the OODA framework as a specialized role |
| `--max-steps <n>` | number | role budget | Cap OODA iterations (only with `--role`) |
| `--max-turns <n>` | number | `8` | Cap provider re-invocations (per step when `--role` is used) |
| `-p, --provider <id>` | string | config default | Provider to run against |
| `-m, --model <id>` | string | provider default | Model id |
| `-s, --system <text>` | string | built-in prompt | System prompt |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |
| `--cwd <dir>` | string | current dir | Working directory for tools and jobs |
| `--read-only` | bool | on | Read-only permission mode (default) |
| `--approve` | bool | off | Workspace-write: auto-approve writes/exec/network |
| `--yolo` | bool | off | Full access, no approval prompts |
| `--principal <id>` | string | config default | Acting principal for enterprise RBAC checks |

**Roles** (values for `--role`): `coordinator`, `planner`, `coder`, `reviewer`,
`tester`, `researcher`, `architect`, `doc-writer`, `security-reviewer`.

Without a role, `agent` runs the fast native tool loop. With a role, it runs the
OODA loop (Observe → Reason → Plan → Act → Evaluate → Repeat): plan drafting,
reflection, retry/self-correction, and dynamic replanning, all on the engine bus.

**Examples**

```bash
nexus agent -p mock -m mock-tools 'read the config'
nexus agent --role coder --max-steps 4 -p mock -m mock-tools 'add a hello function'
nexus agent --approve -p mock -m mock-tools 'create a README'
```

**Notes:** When the target provider is a subprocess coding CLI, `agent` routes
the run to [`code`](#nexus-code) so the wrapped CLI's own loop drives the work.
Built-in tools, LSP tools, enabled tool groups, MCP server tools, and
plugin-contributed tools are all available to the loop. With `--role`, an
unknown role name exits 2 and prints the valid list.

---

### `nexus chat`

Headless line REPL over the engine. Pipe lines in for scripted use; works on
`TERM=dumb`.

**Usage:** `nexus chat [-p <provider>] [-m <model>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p, --provider <id>` | string | config default | Provider to chat with |
| `-m, --model <id>` | string | provider default | Model id |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus chat -p mock
printf 'hello\nand again\n' | nexus chat -p mock
```

**Notes:** The interactive REPL requires a TTY; on a non-TTY, pipe lines in for
headless use. Provider resolution mirrors `ask` — an explicit `-p` that is
unavailable is a hard error, while the default degrades gracefully.

---

### `nexus code`

Drive a subprocess coding CLI (claude-code / codex) through the engine.

**Usage:** `nexus code <task...> [-a <agent>] [-m <model>] [-s <text>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-a, --agent <id>` | string | `claude-code` | Subprocess coding CLI: `claude-code` or `codex` |
| `-p, --provider <id>` | string | — | Alternate spelling of `--agent` (used when `--agent` is absent) |
| `-m, --model <id>` | string | provider default | Model id |
| `-s, --system <text>` | string | built-in prompt | System prompt |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus code --agent claude-code 'fix the failing test'
nexus code -a codex 'add a README'
```

**Notes:** The wrapped agent edits files and runs shells; its file-edit,
tool-result, and approval events stream as UI events (diffs and tool activity on
stderr, the answer on stdout). When the CLI is not installed the command degrades
with a clear message and exits 1 — it never spawns or crashes. Reads the task
from stdin when no positional is given.

---

### `nexus plan`

Turn an objective into a verifiable, dependency-ordered task plan using the
planner role.

**Usage:** `nexus plan <objective...> [--role <name>] [--max-steps <n>] [-p <provider>] [-m <model>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-r, --role <name>` | string | `planner` | Role preset to plan with |
| `--max-steps <n>` | number | role budget | Cap OODA iterations |
| `-p, --provider <id>` | string | config default | Provider to run against |
| `-m, --model <id>` | string | provider default | Model id |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |
| `--cwd <dir>` | string | current dir | Working directory for tools and jobs |

**Examples**

```bash
nexus plan -p mock -m mock-tools 'build a login page'
echo 'ship a CLI installer' | nexus plan -p mock -m mock-tools
```

**Notes:** Reads stdin when no objective is given, and exits 2 with neither.
Persist the resulting work with [`task`](#nexus-task).

---

### `nexus task`

Manage the durable task plan.

**Alias:** `nexus tasks`

**Usage:** `nexus task [list|add|start|done|block|cancel|rm|show|clear] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus task list` | List all tasks (default when omitted); prints progress on stderr |
| `add` | `nexus task add <title> [--parent <id>] [--deps a,b]` | Add a task; reads stdin if no title |
| `start` | `nexus task start <id>` | Mark a task `in_progress` |
| `done` | `nexus task done <id>` | Mark a task `done` |
| `block` | `nexus task block <id>` | Mark a task `blocked` |
| `cancel` | `nexus task cancel <id>` | Mark a task `cancelled` |
| `rm` | `nexus task rm <id>` | Delete a task |
| `show` | `nexus task show <id>` | Show one task with its notes |
| `clear` | `nexus task clear` | Delete every task |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--parent <id>` | string | none | `add`: parent task id (creates a subtask) |
| `--deps <a,b>` | string | none | `add`: comma-separated dependency task ids |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus task add 'write tests'
nexus task add 'ship release' --deps t1,t2
nexus task list
nexus task done <id>
```

---

## Multi-model orchestration

All four fan-out commands take repeatable `-b/--backend` entries in
`provider[:model]` form, and `compare`, `race`, and `consensus` each require at
least two.

### `nexus compare`

Fan one prompt across several providers and print each answer side by side.

**Usage:** `nexus compare <prompt...> -b <p[:m]> -b <p[:m]> [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-b, --backend <p[:m]>` | repeatable | — | Backend lane; at least two required |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus compare -b mock -b mock:mock-smart 'explain recursion'
nexus compare -b mock:mock-fast -b mock:mock-smart -o json 'hi'
```

**Notes:** Exits 2 when fewer than two backends are given, and 1 when a named
provider is not available. Each lane is rendered as its own labelled block, so
answers never interleave.

---

### `nexus race`

Race backends against each other.

**Usage:** `nexus race <prompt...> -b <p[:m]> -b <p[:m]> [--mode first|best]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-b, --backend <p[:m]>` | repeatable | — | Backend lane; at least two required |
| `--mode <m>` | enum | `first` | `first` = fastest healthy answer wins (losers cancelled); `best` = judge-ranked |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus race -b mock -b mock:mock-smart hi
nexus race --mode best -b mock -b mock:mock-smart hi
```

---

### `nexus consensus`

Fan out across backends, then reconcile the answers into one via a judge.

**Usage:** `nexus consensus <prompt...> -b <p[:m]> -b <p[:m]> [--strategy <s>] [--judge <model>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-b, --backend <p[:m]>` | repeatable | — | Backend lane; at least two required |
| `--strategy <s>` | enum | `merge` | `merge`, `rank`, or `vote` |
| `--judge <model>` | string | offline rubric | Judge model hint |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus consensus -b mock -b mock:mock-smart hi
nexus consensus --strategy vote -b mock -b mock:mock-smart 'pick a name'
```

**Notes:** Exits 0 only when the quorum was met and a merged answer was produced.

---

### `nexus chain`

Run staged with hand-offs between stages. The default preset is
plan → edit → review over one provider.

**Usage:** `nexus chain <prompt...> [--stages <p[:m],p[:m],…>] [-p <provider>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--stages <p:m,…>` | string | preset | Explicit comma-separated stage spec, each `provider[:model]` |
| `-p, --provider <id>` | string | `mock` | Provider for the default preset |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus chain 'build a todo app'
nexus chain --stages mock:mock-fast,mock:mock-smart 'plan then write'
```

**Notes:** With no `--stages`, the preset runs three stages (`plan`, `edit`,
`review`). Over `mock` those map to `mock-fast`, `mock-smart`, `mock-fast`. The
chain "passes" (exit 0) only when every stage ran and succeeded. An empty
`--stages` value exits 2.

---

### `nexus route`

Show which provider a route rule picks, or actually run a routed request with
live failover.

**Usage:** `nexus route explain [--optimize <axis>] [...]` · `nexus route test <prompt...> [...]`

**Subcommands**

| Subcommand | Description |
| --- | --- |
| `explain` | Print the chosen candidate and the full ranked candidate list (default) |
| `test` | Dispatch a real run through the router, with live failover |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--optimize <axis>` | enum | `cost` | `cost`, `latency`, `quality`, `local`, or `explicit` |
| `--allow <id>` | repeatable | none | Restrict candidates (e.g. `provider/model`) |
| `--deny <id>` | repeatable | none | Exclude candidates |
| `--fallback <id>` | repeatable | none | Last-resort candidate chain |
| `--cap, --capability <c>` | enum | none | Require a capability: `chat`, `vision`, `code-edit`, `shell`, `tools` |
| `--retries <n>` | number | `3` | `test`: cap same-provider retries before failing over |
| `-o, --output <mode>` | enum | `text` | `text`, `json`, or `ndjson` |

**Examples**

```bash
nexus route explain --optimize cost
nexus route test --optimize local hi
nexus route test --optimize explicit --allow mock-flaky/mock-fast --allow mock/mock-fast --retries 1 hi
```

**Notes:** `route test` prints the candidate order on stderr before dispatching,
and reports which provider actually answered plus any failover hops. When cache
affinity is enabled, the session re-pins to whichever provider answered so its
prompt cache stays warm. `--retries 1` is the way to force cross-provider
failover instead of same-provider recovery.

---

## Code & Git

All four git commands accept a piped diff, which always wins over reading the
repository. Without a pipe they gather the staged diff first, then the working
tree. They accept `-p/--provider`, `-m/--model`, `--cwd`, and `-o/--output`.

### `nexus commit`

Generate a Conventional Commit message from the staged diff.

**Usage:** `nexus commit [--approve] [--cwd <dir>] [-p <provider>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--approve` | bool | off | Apply the generated message with `git commit` |
| `--yolo` | bool | off | Same effect as `--approve` here |
| `--cwd <dir>` | string | current dir | Repository directory |
| `-p, --provider <id>` | string | config default | Provider to generate with |
| `-m, --model <id>` | string | provider default | Model id |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus commit
nexus commit --approve
git diff --staged | nexus commit -p mock
```

**Notes:** Only staged changes are committed. Exits 1 when there is nothing
staged and the working tree is clean.

---

### `nexus review`

Review the current git diff and print severity-tagged comments.

**Usage:** `nexus review [--cwd <dir>] [-p <provider>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--cwd <dir>` | string | current dir | Repository directory |
| `-p, --provider <id>` | string | config default | Provider to review with |
| `-m, --model <id>` | string | provider default | Model id |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus review
git diff | nexus review -p mock
```

**Notes:** Exits 1 when any comment has `error` severity, so it works as a CI
gate.

---

### `nexus explain`

Explain a diff in plain language.

**Usage:** `nexus explain [--cwd <dir>] [-p <provider>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--cwd <dir>` | string | current dir | Repository directory |
| `-p, --provider <id>` | string | config default | Provider to explain with |
| `-m, --model <id>` | string | provider default | Model id |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
git diff | nexus explain
nexus explain --cwd ./packages/core -p mock
```

---

### `nexus pr`

Generate a pull request title and description from commits and diff.

**Usage:** `nexus pr [--base <ref>] [--cwd <dir>] [-p <provider>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--base <ref>` | string | none | Scope to `<ref>..HEAD` commits and `<ref>...HEAD` diff |
| `--cwd <dir>` | string | current dir | Repository directory |
| `-p, --provider <id>` | string | config default | Provider to generate with |
| `-m, --model <id>` | string | provider default | Model id |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus pr --base main
git diff main...HEAD | nexus pr
```

**Notes:** Without `--base`, it summarizes up to the last 20 commits plus the
working diff (or `HEAD~1` when the tree is clean). Exits 1 when there is nothing
to describe.

---

### `nexus lsp`

Code intelligence over the Language Server Protocol.

**Usage:** `nexus lsp <op> <file> [--line <L>] [--character <C>] [--name <newName>]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `definition` | `nexus lsp definition <file> --line L --character C` | Go to definition (default) |
| `references` | `nexus lsp references <file> --line L --character C` | Find references |
| `diagnostics` | `nexus lsp diagnostics <file>` | Report file diagnostics |
| `hover` | `nexus lsp hover <file> --line L --character C` | Hover information |
| `rename` | `nexus lsp rename <file> --line L --character C --name <new>` | Rename a symbol |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--line <n>` | number | `0` | Line position (0-based) |
| `--character <n>` | number | `0` | Character position (0-based) |
| `--name <name>` | string | — | `rename`: the new symbol name (required) |
| `--cwd <dir>` | string | current dir | Workspace root for the server |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus lsp definition src/index.ts --line 10 --character 4
nexus lsp references src/index.ts --line 10 --character 4
nexus lsp diagnostics src/index.ts
nexus lsp rename src/index.ts --line 10 --character 4 --name betterName
```

**Notes:** Positions are 0-based. Requires `lsp.enabled=true` in config (exits 1
otherwise). An unknown language, an uninstalled server, or an unreadable file all
degrade to a clear message on stderr and exit 0, so scripts can probe
availability without treating absence as a crash.

---

## Context & Memory

### `nexus index`

Build the RAG index and the structural repo map for a project directory.

**Usage:** `nexus index [path] [--watch] [--background] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--watch`, `-w` | bool | off | Incremental reindex on debounced changes; runs until Ctrl+C |
| `--background`, `--bg` | bool | config | Fire off a detached reindex and return immediately |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Positional:** `[path]` — directory to index (default: current directory).

**Examples**

```bash
nexus index
nexus index ./src
nexus index --watch
nexus index --background
```

**Notes:** Re-indexing replaces prior chunks for the same document, so it is
cheap and idempotent. Background mode is also the default when
`performance.background` is enabled in config. Exits 1 when no indexable text
files are found. The command builds two things: the embedded chunk index used by
[`search`](#nexus-search), and a PageRank-ranked structural repo map.

---

### `nexus search`

Query the RAG index and show the cited chunks.

**Usage:** `nexus search <query...> [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus search 'how does routing work'
echo 'permission gate' | nexus search
nexus search 'retry policy' -o json
```

**Notes:** Reads the query from stdin when no positional is given. Exits 1 when
no index exists (run `nexus index` first), when the index is empty, or when
nothing matches. The result count comes from `rag.topK` in config. Text output
shows `source:start-end  score=…` plus a snippet per hit; JSON output includes
the separate semantic and keyword scores.

---

### `nexus memory`

Inspect and edit durable memory.

**Usage:** `nexus memory [list|add|get|rm|ingest] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus memory list [--tier <t>]` | List memory items (default when omitted) |
| `add` | `nexus memory add <text> [--tier <t>] [--kind <k>] [--tags a,b]` | Add an item; reads stdin if no text |
| `get` | `nexus memory get <id>` | Show one item |
| `rm` | `nexus memory rm <id>` | Delete one item |
| `ingest` | `nexus memory ingest` | Ingest the repository's instruction files |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--tier <t>` | enum | `long` on add | Memory tier: `long` or `knowledge` |
| `--kind <k>` | string | `note` | Item kind label |
| `--tags <a,b>` | string | none | Comma-separated tags |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus memory add 'this repo uses pnpm workspaces' --tags build,repo
nexus memory list
nexus memory list --tier knowledge -o json
nexus memory ingest
```

---

### `nexus cache`

Inspect or clear the response and embedding caches.

**Usage:** `nexus cache [stats|clear] [-o <mode>]`

**Subcommands**

| Subcommand | Description |
| --- | --- |
| `stats` | Show the cache directory, backend, entry counts, and affinity state (default) |
| `clear` | Delete the `responses` and `embeddings` cache directories |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus cache stats
nexus cache stats -o json
nexus cache clear
```

---

## Tools & Integrations

### `nexus tools`

List every registered tool, or run one directly under the permission gate.

**Usage:** `nexus tools list` · `nexus tools run <tool> --args '<json>'`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus tools list` | List all tool groups with permission class and integration availability (default) |
| `run` | `nexus tools run <tool> --args '<json>'` | Invoke one tool under the permission gate |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--args '<json>'` | string | `{}` | JSON argument object for `run` (or pipe it on stdin) |
| `--read-only` | bool | on | Deny write/exec/network tools (default) |
| `--approve` | bool | off | Workspace-write mode |
| `--yolo` | bool | off | Full access |
| `--cwd <dir>` | string | current dir | Working directory for the tool |
| `--principal <id>` | string | config default | Acting principal for enterprise RBAC checks |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus tools list
nexus tools run db_schema --args '{"connection":{"driver":"sqlite","file":"app.db"}}'
nexus tools run web_fetch --approve --args '{"url":"https://example.com"}'
```

**Notes:** Tool groups (`web`, `browser`, `db`, `cloud`, `containers`, `ai`) are
opt-in per project via `tools.enabledGroups`. A tool from a group that is not
enabled is not runnable — `tools run` says so and prints the exact
`nexus config set` command to enable it. `db_*` tools may reference a named
connection from `tools.db.connections` by string instead of inlining the whole
object. A manual `tools run` is stricter than the agent loop: read-only mode
denies the network tier outright. Plugin-contributed tools appear in `list`
alongside the built-ins.

---

### `nexus mcp`

Declare, list, remove, and discover tools from Model Context Protocol servers.

**Usage:** `nexus mcp [add|list|rm|tools|call] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus mcp list` | List configured servers (default) |
| `add` | `nexus mcp add <name> [flags]` | Declare a server in user config |
| `rm` | `nexus mcp rm <name>` | Remove a server declaration |
| `tools` | `nexus mcp tools` | Connect to every server and list discovered tools |
| `call` | `nexus mcp call <server> <tool> [args]` | Call one discovered tool directly |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--transport <t>` | enum | `stdio` | `add`: `stdio`, `http`, or `sse` |
| `--command <cmd>` | string | — | `add` (stdio): executable to spawn |
| `--args <arg>` | repeatable | — | `add` (stdio): one argv entry per occurrence |
| `--env <K=V>` | repeatable | — | `add` (stdio): child environment variables |
| `--url <url>` | string | — | `add` (http/sse): endpoint URL |
| `--bearer-ref <ref>` | string | — | `add` (http/sse): secret store ref for a bearer token |
| `--disabled` | bool | off | `add`: declare the server but leave it disabled |
| `--json '<obj>'` | string | `{}` | `call`: whole JSON argument object |
| `--arg <K=V>` | repeatable | — | `call`: scalar argument pairs (values are JSON-parsed when possible) |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus mcp add fs --transport stdio --command npx --args -y --args @modelcontextprotocol/server-filesystem
nexus mcp add gh --transport http --url https://mcp.example.com --bearer-ref gh-mcp
nexus mcp list
nexus mcp tools
nexus mcp call fs read_file --arg path=README.md
```

**Notes:** A small set of servers ships as named templates that supply transport,
command, args, and env, so `nexus mcp add <name>` works with no flags; any
explicit flag still overrides the template. Run `nexus mcp add` with no name to
print the list of known templates. Declarations are validated against the MCP
schema before being written, and adding a duplicate name fails — remove it
first. `--arg` values override keys from `--json`. MCP tools registered this way
are also available to the `agent` and `tui` tool loops.

---

### `nexus plugin`

Manage engine-extending plugins.

**Alias:** `nexus plugins`

**Usage:** `nexus plugin [list|add|remove|info] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus plugin list` | Discover and report loaded plugins plus load failures (default) |
| `info` | `nexus plugin info <name>` | Show one plugin's manifest, source, directory, and contributions |
| `add` | `nexus plugin add <dir>` | Add a plugin search directory to user config |
| `remove` (`rm`) | `nexus plugin remove <dir>` | Remove a plugin search directory |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus plugin list
nexus plugin add ./my-plugins
nexus plugin info my-plugin-name
nexus plugin remove ./my-plugins
```

**Notes:** Plugins contribute providers, tools, commands, prompts, MCP servers,
and UI panels into the same engine registries the built-ins use — sandboxed and
version-gated. `add`/`remove` manage the *search directories* (`plugins.dirs`);
the immediate subdirectories of each are scanned as plugins. Paths are resolved
to absolute before being stored.

---

### `nexus jobs`

Terminal integration: background jobs, command history, and the PTY seam.

**Usage:** `nexus jobs [list|run|history|pty] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus jobs list` | List background jobs for this process (default) |
| `run` | `nexus jobs run -- <command> [args...]` | Launch a command as a job, streaming its output |
| `history` | `nexus jobs history` | Show the 20 most recent recorded commands |
| `pty` | `nexus jobs pty` | Report whether a native PTY is available |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--cwd <dir>` | string | current dir | `run`: working directory for the job |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus jobs
nexus jobs run -- echo hello
nexus jobs run --cwd ./packages/core -- npm test
nexus jobs history
nexus jobs pty
```

**Notes:** Background jobs are tracked per process, so a fresh CLI invocation
lists none — `jobs run` launches and waits within a single invocation. Combined
stdout and stderr go to stdout so the output is capturable. `jobs run` exits 0
only when the job exited cleanly with code 0.

---

### `nexus serve`

Start the REST + Server-Sent Events daemon over the same engine the CLI drives.

**Usage:** `nexus serve [--port <n>] [--host <addr>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--port <n>` | number | ephemeral | Bind port (0–65535; an invalid value falls back to ephemeral) |
| `--host <addr>` | string | `127.0.0.1` | Bind host — loopback only by default |

**Examples**

```bash
nexus serve
nexus serve --port 8787
```

**Notes:** Every data route requires a bearer token; `GET /v1/health` is public.
The URL, the generated token, and a ready-to-paste `curl` example are printed on
startup, and the process stays up until Ctrl+C. When the enterprise mode is on,
each bearer token maps to a principal and role, and every data request is
authorized (403 on deny).

---

## Sessions & Observability

### `nexus session`

Manage recorded sessions over the event log.

**Usage:** `nexus session [list|show|rename|branch|delete|export] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus session list` | List sessions with provider, turns, runs, and cost (default) |
| `show` | `nexus session show <sessionId>` | Show one session's metadata and its runs |
| `rename` | `nexus session rename <sessionId> <name>` | Give a session a friendly name |
| `branch` | `nexus session branch <sessionId> [--name <name>]` | Fork a session into a new one |
| `delete` (`rm`) | `nexus session delete <sessionId>` | Delete a session |
| `export` | `nexus session export <sessionId> [--format <f>] [-o <file>]` | Export a session |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name <name>` | string | none | `branch`: name for the new session |
| `--format <f>` | enum | `json` | `export`: `json`, `md` (or `markdown`), or `html` |
| `-o, --output <file>` | string | stdout | `export`: write to a file instead of stdout |

**Examples**

```bash
nexus session list
nexus session show <id>
nexus session rename <id> 'auth refactor'
nexus session branch <id> --name experiment
nexus session export <id> --format html -o session.html
```

**Notes:** For `export`, `-o` doubles as the output-mode flag elsewhere, so the
literal values `text`, `json`, and `ndjson` are treated as modes rather than file
names. Exported files are written with owner-only permissions where the platform
supports it. `branch` also accepts the new name as a trailing positional.
`--mode` is accepted as an alias for `--format`.

---

### `nexus replay`

Re-render a recorded session's timeline.

**Usage:** `nexus replay <sessionId> [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text`, `json` (whole timeline), or `ndjson` (one event per line) |

**Examples**

```bash
nexus replay <sessionId>
nexus replay <sessionId> -o ndjson
```

**Notes:** `ndjson` emits the exact UI event stream one per line, which is what a
TUI or downstream consumer reads. Exits 2 with no session id, 1 when the session
does not exist.

---

### `nexus receipt`

Generate the private, redaction-safe Code Receipt for a session as a
self-contained local HTML file.

**Usage:** `nexus receipt <sessionId> [-o <file.html>] [--prompt <text>] [--title <text>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <file>` | string | temp path | Explicit output file |
| `--prompt <text>` | string | from session | Override the prompt shown on the receipt |
| `--title <text>` | string | from session | Receipt title (also accepts `-s/--system`) |

**Examples**

```bash
nexus receipt <sessionId>
nexus receipt <sessionId> -o ./receipt.html
nexus receipt <sessionId> --title 'Auth refactor' -o ./receipt.html
```

**Notes:** Renders one coding session (prompt → diff → passing tests) into a
single local HTML file and prints only its path. Private by default — never
uploaded or shared. As with `session export`, passing `text`, `json`, or `ndjson`
to `-o` is treated as an output mode, not a file name.

---

### `nexus trace`

Show the span timeline (Gantt style) for a run, session, or trace.

**Usage:** `nexus trace [sessionId|runId|traceId] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus trace
nexus trace <sessionId>
nexus trace <runId> -o json
```

**Notes:** The positional filter is matched as a trace id first, then a run id,
then a session id (resolved through the session store to its trace ids). Exits 1
when no trace data has been recorded yet — run a turn with observability enabled
first.

---

### `nexus history`

Inspect the SQLite run timeline.

**Usage:** `nexus history [list|show] [id] [-o <mode>]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus history list` | Show the 20 most recent runs with tokens and cost (default) |
| `show` | `nexus history show <runId\|sessionId>` | Show the recorded events for one run or session |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus history
nexus history list -o json
nexus history show <runId>
```

---

### `nexus doctor`

Verify providers, keys, pipeline, and subsystem health.

**Usage:** `nexus doctor`

**Examples**

```bash
nexus doctor
```

**Notes:** Prints the config directory and walks the configured providers and
subsystems. This command takes no flags of its own — run it first when something
is not behaving as expected.

---

## Enterprise

These commands read the `enterprise` block of your configuration and are offline
and read-mostly. `budget set` is the one mutation. They all accept `-o json` for
scripting.

### `nexus rbac`

Role-based access control: inspect roles and grants, or check a permission.

**Usage:** `nexus rbac list` · `nexus rbac check --principal <id> --action <a> --resource <type:id>`

**Subcommands**

| Subcommand | Description |
| --- | --- |
| `list` (`roles`) | Show built-in and custom roles, their grants, and the principal directory (default) |
| `check` | Run the fail-closed RBAC + policy authorizer and print ALLOW/DENY |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--principal <id>` | string | config default | Principal to evaluate as |
| `--action <verb>` | string | — | Required for `check` |
| `--resource <type:id>` | string | — | Required for `check` |
| `-o json` | | `text` | Machine-readable output |

**Examples**

```bash
nexus rbac list
nexus rbac check --principal alice --action write --resource tool:fs_write
```

**Notes:** The built-in roles are `admin`, `developer`, `viewer`, and `default`.
`check` exits 1 on deny and prints the deciding source and reason.

---

### `nexus policy`

Declarative policy engine (deny-overrides, fail-closed).

**Usage:** `nexus policy list` · `nexus policy test --principal <id> --action <a> --resource <r> [--cost <usd>]`

**Subcommands**

| Subcommand | Description |
| --- | --- |
| `list` | Print the declarative rule set (default) |
| `test` | Evaluate the combined RBAC + policy decision and show the matched rule |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--principal <id>` | string | config default | Principal to evaluate as |
| `--action <verb>` | string | — | Required for `test` |
| `--resource <type:id>` | string | — | Required for `test` |
| `--cost <usd>` | number | none | Cost context for condition evaluation |
| `-o json` | | `text` | Machine-readable output |

**Examples**

```bash
nexus policy list
nexus policy test --principal bob --action use --resource model:gpt-4o --cost 2.50
```

**Notes:** Exits 1 on deny.

---

### `nexus usage`

Cost and token analytics aggregated over the run history.

**Usage:** `nexus usage [--window <w>] [--provider <p>] [--model <m>] [--from <t>] [--to <t>] [--format <f>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--window <w>` | enum | `day` | Aggregation window: `day`, `week`, or `month` |
| `--provider <id>` | string | all | Filter by provider |
| `--model <id>` | string | all | Filter by model |
| `--from <t>` | number | none | Lower time bound |
| `--to <t>` | number | none | Upper time bound |
| `--format <f>` | enum | none | `csv` or `json` export |
| `--principal <id>` | string | config default | Principal the runs are attributed to |
| `-o json` | | `text` | Machine-readable output |

**Examples**

```bash
nexus usage --window day
nexus usage --window month --format csv
nexus usage --provider anthropic --window week
```

**Notes:** The report totals plus per-provider and per-model breakdowns are
printed in text mode; `--format csv` and `--format json` (or `-o json`) export
the same report.

---

### `nexus audit`

Query the append-only, redacted, hash-chained audit log, or verify its integrity.

**Usage:** `nexus audit [--actor <a>] [--action <a>] [--decision <d>] [--limit <n>]` · `nexus audit --verify`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--verify` | bool | off | Recompute the chain from disk and report any tamper |
| `--actor <id>` | string | all | Filter by acting principal |
| `--action <a>` | string | all | Filter by action |
| `--decision <d>` | string | all | Filter by decision |
| `--from <t>` | number | none | Lower time bound |
| `--to <t>` | number | none | Upper time bound |
| `--limit <n>` | number | `50` | Number of most recent records to show |
| `-o json` | | `text` | Machine-readable output |

**Examples**

```bash
nexus audit --limit 20
nexus audit --actor alice --decision deny
nexus audit --verify
```

**Notes:** `--verify` exits 1 when tampering is detected and lists each finding
with its sequence number and reason.

---

### `nexus budget`

Cost controls: show configured budgets with live spend, or write a budget.

**Alias:** `nexus budgets`

**Usage:** `nexus budget show` · `nexus budget set --id <id> --scope <s> --key <k> --limit <usd> --window <w>`

**Subcommands**

| Subcommand | Description |
| --- | --- |
| `show` (`list`) | List configured budgets with live spend and remaining (default) |
| `set` | Write a budget to user config |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--id <id>` | string | — | Budget id (required for `set`; replaces an existing budget with the same id) |
| `--scope <s>` | enum | — | `principal`, `role`, or `org` (required for `set`) |
| `--key <k>` | string | — | The principal / role / org key the budget applies to (required for `set`) |
| `--limit <usd>` | number | — | Spend cap in USD (required for `set`) |
| `--window <w>` | enum | — | `run`, `day`, or `month` (required for `set`) |
| `--on-exceed <a>` | enum | none | `deny` or `downgrade` |
| `--downgrade-to <model>` | string | none | Model to fall back to when `--on-exceed downgrade` |
| `--warn-threshold <n>` | number | none | Warn at this fraction of the limit |
| `--principal <id>` | string | config default | `show`: principal whose spend to report |
| `-o json` | | `text` | Machine-readable output |

**Examples**

```bash
nexus budget show
nexus budget set --id org-cap --scope org --key acme --limit 500 --window month
nexus budget set --id alice-day --scope principal --key alice --limit 5 --window day --on-exceed downgrade --downgrade-to mock-fast
```

**Notes:** Spend is read from the same persisted store that enforcement accrues
into, so `show` and enforcement always agree. The whole configuration is
validated before a budget is persisted; an invalid budget exits 1 without
writing.

---

## Config & Auth

### `nexus config`

Read and write configuration.

**Usage:** `nexus config [get|set|path] [key] [value]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `get` | `nexus config get [key]` | Print the whole effective config, or one dotted key (default) |
| `set` | `nexus config set <key> <value>` | Write one dotted key to user config |
| `path` | `nexus config path` | Print the user config file path |

**Examples**

```bash
nexus config path
nexus config get
nexus config get defaultProvider
nexus config set defaultProvider mock
nexus config set tools.enabledGroups '["web","db"]'
```

**Notes:** `get` always prints JSON. `set` validates the resulting configuration
against the real schema before writing, so a bad key or value fails loudly
(exit 2) instead of bricking later commands.

---

### `nexus providers`

List or add providers.

**Usage:** `nexus providers list` · `nexus providers add <id> --kind <kind> --adapter <pkg> [flags]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus providers list` | Show every provider with availability and key state (default) |
| `add` | `nexus providers add <id> --kind <k> --adapter <pkg>` | Declare a provider in user config |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--kind <kind>` | string | — | Provider kind (required for `add`) |
| `--adapter <pkg>` | string | — | Adapter package (required for `add`) |
| `--base-url <url>` | string | none | Custom API base URL |
| `--api-key-ref <ref>` | string | none | Secret store ref holding the key |
| `--api-key-env <VAR>` | string | none | Environment variable holding the key |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus providers list
nexus providers list -o json
nexus providers add acme --kind openai --adapter @nexuscode/provider-openai --base-url https://api.acme.test/v1 --api-key-env ACME_API_KEY
```

**Notes:** In `list`, each row is marked `ok` (ready), `key` (configured but
needs a key), or `--` (unavailable).

---

### `nexus models`

List the models for one provider — live from the provider, with a curated
fallback.

**Usage:** `nexus models [provider] [-p <provider>] [-o <mode>]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p, --provider <id>` | string | active default | Provider to list (the positional wins) |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus models
nexus models mock
nexus models -p mock
nexus models mock -o json
```

**Notes:** The target is the positional argument, else `-p/--provider`, else the
configured default provider. This never dumps another provider's models. An
explicitly named provider that is unavailable is a hard error (exit 1); with no
explicit provider, resolution degrades gracefully so `nexus models` always lists
something. A subprocess coding CLI whose model catalog lives in the vendor
session honestly advertises no static models rather than inventing any.

---

### `nexus login`

Sign in to a provider using its real auth flow.

**Usage:** `nexus login [provider] [--device] [--api-key] [--open] [-o json]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--device` | bool | off | Use the headless OAuth device-code flow (RFC 8628) |
| `--api-key` | bool | off | Force the guided API-key path for a composite provider |
| `--open` | bool | off | Auto-open a browser to the key page during a guided API-key login |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |
| `-h, --help` | bool | — | Print the per-provider flow list and exit 0 |

**Examples**

```bash
nexus login                        # interactive provider picker
nexus login openai                 # guided API key
nexus login gemini --device        # headless device-code flow
nexus login anthropic --api-key    # stable console API key
nexus login --help                 # see each provider's real flow
```

**Notes:**

- Each provider runs its own honest flow: a real OAuth 2.0 authorization-code +
  PKCE browser (loopback) flow where the provider offers OAuth, a device-code
  flow with `--device`, a delegate to a wrapped vendor CLI's own login, a
  cloud-SSO delegate, or a guided API-key capture.
- Tokens are stored via the secret store and are **never** printed.
- `--device` only works for a provider with a real device-code endpoint
  (currently the Google-backed providers). Every other provider rejects
  `--device` with a clear error rather than attempting a flow that does not
  exist — use the plain `nexus login <provider>` form there.
- `--open` is off by default: a guided API-key login prints the key-page URL for
  you to open rather than launching a browser at a login-walled page.
- **Anthropic (Claude):** the account OAuth browser flow
  (`nexus login anthropic`) is experimental and may break without notice. The
  most reliable paths are reusing an existing Claude Code CLI session with
  `-p claude-code` (no login needed when `claude` is installed and signed in),
  or `nexus login anthropic --api-key` for a stable API key.
- With no provider argument, an interactive picker runs on a TTY. On a non-TTY it
  prints the available providers and exits 0 rather than crashing.

---

### `nexus logout`

Sign out of a provider by clearing its stored credentials.

**Usage:** `nexus logout [provider] [--all]`

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--all` | bool | off | Sign out of every registered provider |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |
| `-h, --help` | bool | — | Print usage plus the per-provider flow list and exit 0 |

**Examples**

```bash
nexus logout anthropic
nexus logout --all
```

---

### `nexus auth`

Show per-provider sign-in state: whether you are logged in, the method
(oauth / api-key / cli / cloud-sso), and token expiry.

**Usage:** `nexus auth status [-o <mode>]`

**Subcommands**

| Subcommand | Description |
| --- | --- |
| `status` | Show every provider's sign-in state (default, and the only subcommand) |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-o, --output <mode>` | enum | `text` | `text` or `json` |

**Examples**

```bash
nexus auth status
nexus auth status --output json
```

**Notes:** When nothing is signed in, a hint to run `nexus login` is printed on
stderr, so stdout stays clean for scripting.

---

### `nexus keys`

Manage secrets. Values are always masked and never printed in full.

**Usage:** `nexus keys [list|set|test] [args...]`

**Subcommands**

| Subcommand | Usage | Description |
| --- | --- | --- |
| `list` | `nexus keys list` | List known secret refs with their source and a masked value (default) |
| `set` | `nexus keys set <ref> [value]` | Store a secret; prompts with echo off on a TTY |
| `test` | `nexus keys test <provider>` | Run the provider's health probe with the stored credential |

**Flags**

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--value <secret>` | string | — | `set`: supply the value as a flag instead of a positional |
| `--stdin` | bool | off | `set`: read one line of the value from piped stdin |

**Examples**

```bash
nexus keys list
nexus keys set my-provider           # prompts, input hidden
printf '%s\n' "$MY_KEY" | nexus keys set my-provider --stdin
nexus keys test mock
```

**Notes:** Prefer [`nexus login`](#nexus-login) — it runs the real per-provider
sign-in flow. Use `keys set` for a raw API key or a bearer-token ref referenced
elsewhere in configuration. With no explicit value and no `--stdin`, the value is
prompted for with echo disabled so it never reaches argv, `ps`, or shell history.
`keys test` exits 1 when the probe fails; a provider with no health probe is
reported as assumed reachable.

---

## See also

- `README.md` — project overview and installation
- `docs/GETTING-STARTED.md` — first-run walkthrough
- `docs/CONFIGURATION.md` — every configuration key
- `docs/PROVIDERS.md` — provider setup and authentication
- `docs/ARCHITECTURE.md` — how the engine fits together
