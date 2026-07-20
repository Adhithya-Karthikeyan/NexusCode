# Getting Started with NexusCode

NexusCode is a provider-agnostic AI CLI harness. This guide takes you from an empty
directory to a working `nexus` command, a real answer with **no API key at all**, and
then on to a real provider.

Budget about 15 minutes, most of which is the build.

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js >= 20.11** | Enforced by `engines` in every package. `node --version` to check. |
| **npm** | Ships with Node. The repo is an npm workspaces monorepo (`packages/*`, `packages/providers/*`). |
| **git** | To clone the repository. |
| **A C/C++ toolchain** | `better-sqlite3` is a dependency of the CLI and compiles a native addon during `npm install`. macOS: `xcode-select --install`. Debian/Ubuntu: `build-essential` + `python3`. Windows: the "Desktop development with C++" workload. |

Everything else — including all 11 provider adapters — is plain JavaScript.

---

## 2. Install from source

> **NexusCode is not published to npm.** There is no `@nexuscode/cli` package on the
> registry, so `npm install -g @nexuscode/cli` will not work. Building from source is
> the only supported install.

```bash
git clone https://github.com/Adhithya-Karthikeyan/NexusCode.git
cd NexusCode
npm install
npm run build
npm link --workspace=@nexuscode/cli
```

- `npm install` resolves the workspace and compiles `better-sqlite3`.
- `npm run build` compiles every package in dependency order, finishing with
  `@nexuscode/cli`, which produces `packages/cli/dist/index.js`.
- `npm link --workspace=@nexuscode/cli` puts the `nexus` command on your `PATH`.

Use **npm** throughout. The repository's lockfile is `package-lock.json`, and npm is what
the project is built and tested with.

Verify it worked:

```bash
nexus --help
```

You should see the command list (`nexus agent`, `nexus ask`, `nexus audit`, …).

### Getting the `nexus` command on your PATH

`npm link --workspace=@nexuscode/cli` symlinks the package into npm's global prefix and
installs the single `nexus` binary. If `nexus` is "command not found" afterwards, see
[Troubleshooting](#7-troubleshooting).

**If you would rather not write to your global npm prefix**, skip the link step. The
built entrypoint is directly runnable — it carries a `#!/usr/bin/env node` shebang and
the executable bit:

```bash
node packages/cli/dist/index.js ask -p mock 'hello'
```

Or bind just that one path to a name of your choosing:

```bash
# add to ~/.zshrc or ~/.bashrc, using the absolute path to your clone
alias nexus='node /absolute/path/to/NexusCode/packages/cli/dist/index.js'
```

From here on, `nexus` means either the linked binary or
`node packages/cli/dist/index.js` — they are interchangeable.

---

## 3. Zero-key first run

NexusCode ships a built-in `mock` provider: deterministic, fully offline, zero network,
zero credentials. It is registered unconditionally at startup, so you can prove your
install works before signing up for anything.

```bash
nexus ask -p mock 'hello'
```

```
[mock-fast] Echo: hello
[usage] mock:mock-fast in=2 out=6 cost=$0.000000 finish=stop
[trace] ttft=0ms latency=1ms spans=2
```

That is the whole engine running end to end — routing, streaming, usage accounting,
tracing — with nothing configured.

Three mock models are available, each deterministic:

```bash
nexus models mock
```

```
mock (mock)
  mock-fast  (32k ctx)
  mock-smart  (32k ctx)
  mock-tools  (32k ctx)
```

- `mock-fast` — echoes your prompt.
- `mock-smart` — a longer canned reply, for testing multi-lane output.
- `mock-tools` — drives the agentic tool loop, so `nexus agent` works offline.

Two extra offline variants, `mock-flaky` and `mock-slow`, are also registered. They
exist to exercise failover and latency routing without touching a network.

---

## 4. See what you actually have

Before adding a provider, look at the catalog NexusCode registered for you:

```bash
nexus providers list
```

```
ok  mock (mock)
ok  mock-flaky (mock)
ok  mock-slow (mock)
key groq (openai-compat) — needs key: GROQ_API_KEY
key together (openai-compat) — needs key: TOGETHER_API_KEY
key deepseek (openai-compat) — needs key: DEEPSEEK_API_KEY
key mistral (openai-compat) — needs key: MISTRAL_API_KEY
key openrouter (openai-compat) — needs key: OPENROUTER_API_KEY
key nvidia (openai-compat) — needs key: NVIDIA_API_KEY
ok  lmstudio (openai-compat) — local — no key needed (start the server to use)
ok  vllm (openai-compat) — local — no key needed (start the server to use)
key azure-openai (azure) — needs key: AZURE_OPENAI_API_KEY + endpoint
ok  claude-code (subprocess) — claude on PATH
ok  codex (subprocess) — codex on PATH
key gemini (gemini) — needs key: GEMINI_API_KEY
key bedrock (bedrock) — needs creds: AWS credential chain (…)
key vertex (vertex) — needs creds: GCP ADC (…)
```

The three markers mean:

- `ok` — registered and usable right now.
- `key` — registered, but no credential is resolvable yet.
- `--` — the adapter could not be constructed at all.

Registration is entirely offline. Nothing here made a network call; "needs key" is a
statement about your environment, not about provider reachability.

> **Not in the list?** `openai`, `ollama`, and `grok` are **not** registered by default
> — they need one line of config. `anthropic` appears once you have signed in.
> [PROVIDERS.md](./PROVIDERS.md) has the exact setup for each.

`nexus doctor` is the fuller version of the same picture: it adds config paths, the
history database location, per-provider sign-in state, and every subsystem
(context, memory, tools, agent, tasks, terminal, RAG, cache, tracing, git, LSP, tool
groups, MCP).

```bash
nexus doctor
```

---

## 5. Sign in to a real provider

`nexus login` runs the genuine auth flow for the provider you name — browser OAuth,
device code, a delegate to a vendor CLI's own login, or a guided API-key capture.
Credentials go into the SecretStore and are never printed.

```bash
nexus login              # prompts you to pick a provider
nexus login openai       # guided API key (OpenAI authenticates by key)
nexus login gemini       # browser OAuth; --device for a headless box
nexus login anthropic    # Claude account OAuth (experimental — see below)
```

Then confirm:

```bash
nexus auth status
nexus doctor
```

### The reliable Claude paths

`nexus login anthropic` runs a real Claude-account OAuth flow, but the CLI itself
labels it **experimental**: Anthropic can change those endpoints without notice. Two
sturdier options:

```bash
# 1. Reuse an existing, already-logged-in Claude Code CLI session — no login needed.
nexus ask -p claude-code 'hi'

# 2. Capture a stable console API key instead of an OAuth token.
nexus login anthropic --api-key
```

### If you would rather just set an environment variable

Every provider resolves its credential from an environment variable first, before the
keychain and the encrypted vault. So this works with no login at all:

```bash
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export GROQ_API_KEY=...
```

See [CONFIGURATION.md](./CONFIGURATION.md#secrets) for the full resolution chain and
[PROVIDERS.md](./PROVIDERS.md) for the variable each provider reads.

### List a provider's models

```bash
nexus models                 # the active default provider
nexus models openai          # one named provider
nexus models mock -o json    # machine-readable
```

`nexus models` asks the provider's real models endpoint when it can, and falls back to
a curated static catalog when there is no key, no network, or no list endpoint.

---

## 6. Your first real conversation

**A one-shot completion.** It reads both the positional prompt and piped stdin, joining
them, so it composes naturally in a pipeline:

```bash
nexus ask 'explain what a monorepo is'
git diff | nexus ask 'review this diff'
git diff | nexus ask -s 'You are a terse senior reviewer' 'review this diff'
cat error.log | nexus ask -o json 'what is failing here'
```

**A headless REPL** — line in, answer out; works on `TERM=dumb` and over pipes:

```bash
nexus chat
```

**The full interactive terminal UI** — panes, themes, live tool activity:

```bash
nexus tui
nexus tui --theme nexus-noir
nexus tui --preset compare
```

`nexus tui` needs a real TTY. On a non-TTY, `TERM=dumb`, or a very narrow terminal it
prints why and drops to linear mode instead of crashing. Set `NEXUS_FORCE_TUI=1` to
override that check.

Sixteen themes ship: `nexus-noir`, `paper-nexus`, `solar-flare`, `glacier`,
`contrast-max`, `synthwave-grid`, `neon`, `midnight`, `vampire`, `retro-amber`,
`pastel`, `frost`, `matrix`, `vivid`, `rose`, `forest`. Four layout presets: `chat`,
`agent`, `compare`, `dashboard`.

---

## 7. Try these next

Every command below runs offline against `mock`, so you can explore the whole surface
before spending a token.

**An agentic run** — the native tool loop, or the full OODA framework with a role:

```bash
nexus agent -p mock -m mock-tools 'read the config'
nexus agent --role coder --max-steps 4 -p mock -m mock-tools 'add a hello function'
```

Tool permissions default to read-only. `--approve` allows workspace writes and
auto-approves exec/network; `--yolo` is full access with no prompts.

**Ask several providers at once:**

```bash
nexus compare -b mock -b mock:mock-smart 'hi'      # side by side
nexus race -b mock -b mock:mock-smart 'hi'         # fastest wins, losers cancelled
nexus race --mode best -b mock -b mock:mock-smart 'hi'   # judge-ranked
nexus consensus -b mock -b mock:mock-smart 'hi'    # fan out, then reconcile
nexus chain 'build a todo app'                     # staged plan → edit → review
```

**Index a repository for retrieval:**

```bash
nexus index                     # index the current directory
nexus index ./src               # a subtree
nexus index --watch             # incremental reindex on change
nexus search 'how does routing work'
```

The default embedder is `hashing`: deterministic and fully offline, so indexing and
search need no API key. Secret scanning is on by default, so detected credentials are
redacted before anything is embedded or persisted.

**Understand a routing decision:**

```bash
nexus route explain --optimize cost
nexus route test --optimize local 'hi'
```

**Work with sessions and history:**

```bash
nexus session list
nexus session export <id> --format html -o session.html
nexus history list
nexus trace <sessionId>
nexus receipt <sessionId>       # a private, local HTML "Code Receipt"
```

**Git-aware helpers** (these call your default provider, so sign in first):

```bash
nexus review                    # review the working tree
git diff | nexus explain
nexus commit                    # a Conventional Commit message; --approve applies it
nexus pr --base main
```

Full reference: [COMMANDS.md](./COMMANDS.md).

---

## 8. Troubleshooting

### `npm install` fails building `better-sqlite3`

The error mentions `node-gyp`, `prebuild-install`, a missing `python3`, or a C++
compiler. The CLI depends on `better-sqlite3` for the run-history database, and it
compiles a native addon.

- **macOS** — install the Command Line Tools: `xcode-select --install`.
- **Debian/Ubuntu** — `sudo apt-get install -y build-essential python3`.
- **Windows** — install the Visual Studio "Desktop development with C++" workload.
- Confirm `node --version` is at least 20.11. A very new, very fresh major release may
  not have prebuilt binaries yet and will force a source compile.

Then delete `node_modules` and re-run `npm install`.

### `nexus: command not found` after `npm link`

The link succeeded but npm's global bin directory is not on your `PATH`.

```bash
npm prefix -g          # e.g. /usr/local  or  ~/.npm-global
ls "$(npm prefix -g)/bin/nexus"
```

If the symlink exists, add `$(npm prefix -g)/bin` to your `PATH` and restart the shell.
If it does not, re-run `npm link --workspace=@nexuscode/cli` from the repository root
and read the output for a permissions error — some global prefixes need `sudo`, in which
case the alias from [section 2](#getting-the-nexus-command-on-your-path) avoids the
problem entirely.

Either way, `node packages/cli/dist/index.js` always works and needs no PATH changes.

### `nexus: provider "openai" is not available (try -p mock)`

That provider is registered under a different id, or is not in the default catalog at
all. Run `nexus providers list` to see the real catalog — it is the source of truth.

Common cases:

- **`openai`, `ollama`, `grok`** are not registered by default. Add one with
  `nexus providers add` — see [PROVIDERS.md](./PROVIDERS.md).
- **Azure** is registered as `azure-openai`, not `azure`.
- **`anthropic`** only appears in the catalog for commands that resolve credentials
  (`ask`, `agent`, `chat`, `tui`) and only once you have signed in or set
  `ANTHROPIC_API_KEY`. `nexus providers list` and `nexus doctor` do not do
  auth-aware registration, so they will not show it.

### A provider shows `needs key`

The adapter is registered; no credential resolved. Either sign in or export the
variable the status line names:

```bash
nexus login <provider>
# or
export GROQ_API_KEY=...
```

Confirm with `nexus keys list` (values are always masked) or `nexus auth status`.

To check that a key actually works, `nexus keys test <provider>` runs the adapter's
health probe.

### "no provider is available" / everything falls back to mock

On a fresh machine with no credentials, NexusCode deliberately falls back to the
offline `mock` provider rather than dead-ending. A default run (`nexus`, `nexus ask`
with no `-p`) will tell you it fell back. Sign in with `nexus login`, or name a
provider explicitly with `-p`, which errors clearly instead of falling back.

### An auth token expired

`nexus doctor` reports it, e.g. `access token expired — will refresh on next use`. An
OAuth provider refreshes automatically on the next call. If the refresh token is dead
too, sign in again:

```bash
nexus logout anthropic
nexus login anthropic
```

`nexus logout --all` clears every provider.

### `claude-code` or `codex` reports "not installed"

Those adapters drive an already-installed vendor CLI as a subprocess. NexusCode does
not install them. Install the vendor CLI, make sure its binary (`claude` / `codex`) is
on `PATH`, and log into it with its own login. `nexus doctor` re-checks `PATH` on every
run. If your binary lives somewhere unusual, point at it with `NEXUS_CLAUDE_CODE_BIN` /
`NEXUS_CODEX_BIN`.

### `nexus tui` drops to linear mode

It prints the reason: not a TTY (piped or redirected), `TERM=dumb`, or a terminal
narrower than the minimum. Widen the window, run it directly in a terminal, or force it
with `NEXUS_FORCE_TUI=1`.

### A config change seems to be ignored

Check where your config is actually being read from and what the merged result is:

```bash
nexus config path      # the file the CLI writes to
nexus config get       # the fully merged, validated config
```

Two behaviours surprise people:

- **Arrays replace, they do not concatenate.** A project-level `routing` array fully
  overrides the user-level one.
- **Executable fields are stripped from project config.** A config file that ships
  inside a cloned repository is untrusted, so spawn-bearing settings (`lsp.servers`,
  stdio `mcp` entries, `providers` entries with a `command`, `hooks.hooks`,
  `plugins.dirs`) are dropped with a warning on stderr. Put those in your user config.

[CONFIGURATION.md](./CONFIGURATION.md) covers the precedence rules in full.

---

## Where to go next

- **[CONFIGURATION.md](./CONFIGURATION.md)** — every config key, precedence, secrets, environment variables.
- **[PROVIDERS.md](./PROVIDERS.md)** — all providers, their auth, and their limits.
- **[COMMANDS.md](./COMMANDS.md)** — the complete command reference.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the engine is put together.
