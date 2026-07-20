# Providers

A **provider** in NexusCode is anything that satisfies the `ProviderAdapter` contract:
a hosted model API, a local server, or an entire coding CLI driven as a subprocess. They
are interchangeable. The same `nexus ask`, `nexus agent`, and `nexus tui` run against any
of them, and routing can fail over between them mid-request.

This document covers what ships, how to authenticate each one, and how a provider gets
picked.

---

## The three families

**12 adapters across 11 packages.** Eleven directories live under
`packages/providers/`; the `openai` package ships two adapters, since it additionally
provides a ready xAI Grok adapter alongside the native OpenAI one. They fall into three
families, which is the useful way to think about them.

### 1. Native SDK adapters

Each wraps the vendor's official SDK behind the frozen adapter contract.

| Package | Provider id | Backing SDK |
| --- | --- | --- |
| `@nexuscode/provider-anthropic` | `anthropic` | `@anthropic-ai/sdk` |
| `@nexuscode/provider-gemini` | `gemini` | `@google/genai` |
| `@nexuscode/provider-vertex` | `vertex` | `@google/genai` in Vertex mode |
| `@nexuscode/provider-bedrock` | `bedrock` | AWS Bedrock Converse API |
| `@nexuscode/provider-azure` | `azure-openai` | `AzureOpenAI` (which extends `OpenAI`) |

### 2. The OpenAI-compatible transport

`@nexuscode/provider-openai` contains one battle-tested transport — request converter,
streaming state machine, error taxonomy — and **every** OpenAI-compatible backend reuses
it. Only the base URL, credential, and model catalog differ. That includes Ollama, which
ships as `@nexuscode/provider-ollama` but rides the same transport.

The package exports two ready adapters of its own: the native **OpenAI** adapter and an
**xAI Grok** adapter (`https://api.x.ai/v1`, key `XAI_API_KEY`). Both need a one-line
config entry to be registered — see [below](#xai-grok).

Eight compatible providers are pre-wired and registered automatically:

| Provider id | Base URL | Key |
| --- | --- | --- |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `lmstudio` | `http://localhost:1234/v1` | none — local |
| `vllm` | `http://localhost:8000/v1` | none — local |

Three more ride the same transport but need a one-line config entry: `openai`, `ollama`,
and `grok`. See [Providers you must add](#providers-you-must-add-yourself).

### 3. Subprocess adapters

`@nexuscode/provider-subprocess` is a base that drives an already-installed coding CLI
headlessly, streams its NDJSON, and normalizes it into the same `StreamChunk` union
every other provider emits — including file edits, tool calls, and approval events.

| Package | Provider id | Drives |
| --- | --- | --- |
| `@nexuscode/provider-claude-code` | `claude-code` | `claude -p --output-format stream-json` |
| `@nexuscode/provider-codex` | `codex` | `codex exec --json` |

This is what lets a full agentic coding CLI act as a provider: `nexus ask -p claude-code`
uses the vendor CLI's own session and its own login, and NexusCode never parses a human
TUI — always the structured stream.

Plus one more, in a family of its own:

| Package | Provider id | Notes |
| --- | --- | --- |
| `@nexuscode/provider-mock` | `mock`, `mock-flaky`, `mock-slow` | Deterministic, offline, zero network, zero keys. |

---

## The full catalog

Run `nexus providers list` — it is the source of truth for your machine. This is what a
fresh install registers, with nothing configured:

| Provider | What it is | Auth method | Network? | Keys? | Notable limits |
| --- | --- | --- | --- | --- | --- |
| `mock` | Deterministic offline provider | none | No | No | Canned replies only. Three models: `mock-fast`, `mock-smart`, `mock-tools`. |
| `mock-flaky` | Mock that fails intermittently | none | No | No | Exists to exercise failover. |
| `mock-slow` | Mock with injected latency | none | No | No | Exists to exercise latency routing. |
| `anthropic` | Claude, via the official SDK | OAuth (Claude account) **or** API key | Yes | Yes | OAuth flow is experimental. Only registered by commands that resolve credentials (`ask`/`agent`/`chat`/`tui`), not by `providers list`. |
| `azure-openai` | Azure OpenAI Service | API key | Yes | Yes | Needs endpoint + deployment + API version, not just a key. Routes by *deployment*, not model name. |
| `gemini` | Google Gemini Developer API | Google OAuth, gcloud delegate, or API key | Yes | Yes | — |
| `vertex` | Google Vertex AI | GCP Application Default Credentials / OAuth | Yes | Creds | Needs a project id; defaults to region `us-central1`. |
| `bedrock` | Amazon Bedrock (Converse API) | AWS credential chain / `aws sso login` | Yes | Creds | Model ids are Bedrock/inference-profile ids, not vendor names. |
| `groq` | Fast hosted inference | API key | Yes | Yes | — |
| `together` | Together AI | API key | Yes | Yes | — |
| `deepseek` | DeepSeek | API key | Yes | Yes | — |
| `mistral` | Mistral | API key | Yes | Yes | — |
| `openrouter` | Multi-vendor gateway | API key | Yes | Yes | Model ids are namespaced, e.g. `anthropic/claude-3.5-sonnet`. |
| `nvidia` | NVIDIA NIM | API key | Yes | Yes | — |
| `lmstudio` | Local LM Studio server | none | Local only | No | You must start LM Studio's server first. |
| `vllm` | Local vLLM server | none | Local only | No | You must start vLLM first. |
| `claude-code` | Claude Code CLI as a provider | delegates to `claude`'s own login | Via the CLI | No | Requires `claude` installed and on `PATH`. |
| `codex` | Codex CLI as a provider | delegates to `codex`'s own login | Via the CLI | No | Requires `codex` installed and on `PATH`. Its `--json` event schema has shifted across versions; unrecognized events are ignored rather than failing. |

Registration is entirely offline. NexusCode never makes a network call to decide whether
a provider is "available" — it only checks whether a credential is *resolvable* and, for
subprocess providers, whether the binary is on `PATH`. That is why `nexus providers list`
and `nexus doctor` are instant and always exit 0 on an unconfigured machine.

### Providers you must add yourself

Three widely used providers are **not** in the default catalog and need a config entry:
`openai`, `ollama`, and `grok`. Each takes one command.

---

## Per-provider setup

### Anthropic (Claude)

Three honest paths, in order of reliability:

```bash
# 1. Most reliable: reuse an already-logged-in Claude Code CLI session.
#    No NexusCode login at all — see the claude-code section below.
nexus ask -p claude-code 'hi'

# 2. A stable console API key.
nexus login anthropic --api-key
#    or just:
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Claude account OAuth — the same flow Claude Code's own CLI uses.
nexus login anthropic
```

Option 3 is a real OAuth 2.0 authorization-code flow with PKCE. Anthropic's authorize
endpoint rejects a loopback redirect, so it uses the vendor's callback page, which
*displays* a `code#state` string for you to paste back into the CLI. The token is sent as
a Bearer credential with the required beta opt-in header, and refreshes automatically.

The CLI labels this flow **experimental** in its own help text, and so do we: Anthropic
can change those endpoints without notice. If you want stability, use option 1 or 2.

`--device` does not work here — Anthropic has no device-code endpoint, and NexusCode
rejects the flag with a clear error rather than attempting a flow that does not exist.

**Curated model catalog** (used when live discovery is unavailable): `claude-opus-4-1`,
`claude-opus-4-0`, `claude-sonnet-4-5`, `claude-sonnet-4-0`, `claude-3-7-sonnet-latest`,
`claude-3-5-haiku-latest`.

> `anthropic` is registered lazily and only by commands that resolve credentials
> (`ask`, `agent`, `chat`, `tui`). It will not appear in `nexus providers list` or
> `nexus doctor`, which do credential-free registration. Use `nexus auth status` to
> confirm your Anthropic sign-in.

### OpenAI

Not in the default catalog. Add it once:

```bash
nexus providers add openai \
  --kind openai-compat \
  --adapter @nexuscode/provider-openai \
  --api-key-env OPENAI_API_KEY
```

Then authenticate. OpenAI has no OAuth for API access, so the honest flow is a guided
key capture:

```bash
nexus login openai            # prints the key page URL and captures the key
export OPENAI_API_KEY=sk-...  # or just set the variable
```

Equivalent config:

```json
{
  "providers": [
    {
      "id": "openai",
      "kind": "openai-compat",
      "adapter": "@nexuscode/provider-openai",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  ]
}
```

Curated catalog: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `o3`, `o4-mini`.
The adapter also backs embeddings (default model `text-embedding-3-small`), so you can
set `rag.embedder: "openai"`.

### Azure OpenAI

Registered by default as **`azure-openai`** (not `azure`). Azure routes by *deployment*
rather than by model name, so it needs more than a key:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com
export AZURE_OPENAI_DEPLOYMENT=gpt-4o
export AZURE_OPENAI_API_VERSION=2024-10-21

nexus login azure-openai      # guided key capture, if you prefer
```

Without `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT`, the adapter is still
constructed (offline, no network) using placeholders — a real call fails fast with an
auth error rather than silently reaching somewhere wrong.

### Google Gemini (Developer API)

```bash
nexus login gemini                # browser OAuth (or a gcloud ADC delegate)
nexus login gemini --device       # headless device-code flow
nexus login gemini --api-key      # guided API key
export GEMINI_API_KEY=...         # or set it directly
```

The adapter reads `GEMINI_API_KEY` first, then `GOOGLE_API_KEY`, then the SecretStore
under the ref `gemini`. Change the variable it reads with `gemini.apiKeyEnv`.

Gemini and Vertex are the only providers with a real device-code endpoint, so `--device`
works here and nowhere else.

Default aliases: `gemini-flash` → `gemini-2.0-flash`, `gemini-pro` → `gemini-1.5-pro`.

```json
{
  "gemini": {
    "enabled": true,
    "apiKeyEnv": "GEMINI_API_KEY",
    "modelMap": { "fast": "gemini-2.0-flash" }
  }
}
```

### Google Vertex AI

Vertex authenticates with Google Cloud Application Default Credentials, not an API key:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=my-project

nexus login vertex               # browser OAuth, or delegates to gcloud
nexus login vertex --device      # headless
```

NexusCode considers ADC present when `GOOGLE_APPLICATION_CREDENTIALS` points at a real
file, or `~/.config/gcloud/application_default_credentials.json` exists (`%APPDATA%\gcloud\…`
on Windows). That check is a file check — never a network call.

```json
{
  "vertex": {
    "enabled": true,
    "project": "my-project",
    "location": "us-central1",
    "modelMap": { "vertex-flash": "gemini-2.0-flash" }
  }
}
```

For a `providers[]` entry of kind `vertex`, project and location come from
`flags.project` / `flags.location`, falling back to `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION` (default `us-central1`).

### Amazon Bedrock

Uses the standard AWS credential chain — no NexusCode-specific key:

```bash
aws sso login                    # or any normal AWS credential setup
export AWS_REGION=us-east-1

nexus login bedrock              # delegates to `aws sso login`
```

Credentials are considered present when any of these hold: `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY`, `AWS_PROFILE`, `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`,
a container-credentials URI, or a `~/.aws/credentials` or `~/.aws/config` file. Again, a
file and environment check only.

```json
{
  "bedrock": {
    "enabled": true,
    "region": "us-east-1",
    "modelMap": { "sonnet": "anthropic.claude-3-5-sonnet-20241022-v2:0" }
  }
}
```

For a `providers[]` entry of kind `bedrock`, region comes from `flags.region`, then
`AWS_REGION`, then `AWS_DEFAULT_REGION`.

### Groq, Together, DeepSeek, Mistral, OpenRouter, NVIDIA

All registered by default; all authenticate by API key. Pick either style:

```bash
nexus login groq          # guided capture, stores in the SecretStore
export GROQ_API_KEY=...   # or set the variable
```

Same for `together` / `TOGETHER_API_KEY`, `deepseek` / `DEEPSEEK_API_KEY`, `mistral` /
`MISTRAL_API_KEY`, `openrouter` / `OPENROUTER_API_KEY`, `nvidia` / `NVIDIA_API_KEY`.

### xAI Grok

Rides the OpenAI-compatible transport; needs a config entry:

```bash
nexus providers add grok \
  --kind openai-compat \
  --adapter @nexuscode/provider-openai \
  --base-url https://api.x.ai/v1 \
  --api-key-env XAI_API_KEY

export XAI_API_KEY=xai-...
```

### Ollama (local)

Needs a config entry, then nothing else — no key, no account, no network beyond
localhost:

```bash
ollama serve
ollama pull llama3.2

nexus providers add ollama \
  --kind openai-compat \
  --adapter @nexuscode/provider-openai \
  --base-url http://localhost:11434/v1

nexus ask -p ollama -m llama3.2 'hello'
```

NexusCode treats a provider as **local** when its id is `ollama` or its base URL
contains port `11434`. Local providers skip the auth requirement entirely and are
accounted at zero cost, which also makes them the preferred targets of
`optimize: "local"` routing.

Ollama's OpenAI-compatible endpoint is served at `http://localhost:11434/v1`; the adapter
discovers your pulled models from Ollama's own tags endpoint.

### LM Studio and vLLM (local)

Already in the default catalog, no key needed. Start the server and go:

```bash
# LM Studio: enable its local server (defaults to port 1234)
nexus ask -p lmstudio 'hello'

# vLLM: python -m vllm.entrypoints.openai.api_server --model <model>
nexus ask -p vllm 'hello'
```

They show as `ok — local — no key needed (start the server to use)` whether or not the
server is actually running, because registration never probes the network.

### Claude Code and Codex (subprocess)

These drive a coding CLI you already have installed. NexusCode does not install, update,
or authenticate them — it delegates to their own login.

```bash
# Install the vendor CLI yourself, then log into it with its own command.
nexus login claude-code      # runs `claude /login`
nexus login codex            # runs `codex login`

nexus ask -p claude-code 'hi'
nexus code --agent claude-code 'fix the failing test'
nexus code -a codex 'add a README'
```

`nexus doctor` reports whether each binary is on `PATH` and whether a session file was
detected. If your binary lives somewhere unusual, point at it:

```bash
export NEXUS_CLAUDE_CODE_BIN=/opt/homebrew/bin/claude
export NEXUS_CODEX_BIN=/usr/local/bin/codex
```

**What makes these different from chat providers:** they edit files and run shells.
Their file-edit, tool-result, and approval events stream through the same `UiEvent`
pipeline, so you see diffs and tool activity live. Because the vendor CLI owns the model
catalog, these providers advertise no static model list — reported honestly rather than
invented.

**Limitations worth knowing.** The adapters are registered unconditionally so that
`nexus code` can dispatch through the normal engine path and surface a clean transport
error; an absent binary shows as `not installed` and never crashes. The Codex `--json`
schema is less formally specified than Claude Code's and has changed across versions, so
the event mapping is best-effort — unrecognized events are ignored rather than treated as
failures.

### Mock (offline)

Always registered, always first, never needs anything:

```bash
nexus ask -p mock 'hello'
nexus agent -p mock -m mock-tools 'read the config'
nexus compare -b mock -b mock:mock-smart 'hi'
```

| Model | Behaviour |
| --- | --- |
| `mock-fast` | Terse echo of your prompt. |
| `mock-smart` | A longer "considered" reply — useful for testing multi-lane output. |
| `mock-tools` | Calls a tool on its first turn, then answers — drives the agent loop offline. |

`mock-flaky` and `mock-slow` are separate providers that fail intermittently and add
latency, so you can exercise failover and latency routing deterministically.

---

## Local and offline options

If you would rather nothing left your machine:

| Option | Network | Notes |
| --- | --- | --- |
| `mock` | none at all | Canned replies. Proves the harness works; not a real model. |
| `ollama` | localhost only | Real local models. Needs a config entry (above). |
| `lmstudio` | localhost only | Real local models. Already registered. |
| `vllm` | localhost only | Real local models. Already registered. |
| `claude-code` / `codex` | whatever the vendor CLI does | Local process; the CLI itself talks to its vendor. |

Two adjacent defaults reinforce this:

- **RAG** uses the `hashing` embedder by default — deterministic, offline, no key. You
  can index and search a repository with no network at all. Secret scanning is on by
  default, so detected credentials are redacted before anything is embedded or persisted,
  which also blocks exfiltration through a remote embedder if you switch to one.
- **`web_search`** defaults to a deterministic `mock` search provider, and `web_fetch` /
  `web_crawl` sit behind an SSRF guard that blocks private and loopback addresses unless
  you explicitly allowlist them.

To force routing toward local providers:

```bash
nexus route test --optimize local 'hi'
```

```json
{ "routing": [{ "when": {}, "use": "ollama", "optimize": "local" }] }
```

---

## How a provider is chosen

### Without routing rules

1. An explicit `-p <provider>` wins. If it is not registered, the command **errors** —
   naming a provider you cannot use should fail loudly, not silently substitute.
2. Otherwise `config.defaultProvider` is used, if it has a usable credential.
3. If it does not, NexusCode falls back rather than dead-ending a first-run user:
   `mock` first, then a reachable local provider (`ollama`, `lmstudio`, `vllm`), then
   anything else that is actually usable. The fallback is announced, never silent.

"Usable" means registered **and** holding a resolvable credential of any kind: none
needed (mock, local), an API key from the environment or SecretStore, a stored
non-expired OAuth token, or a detected vendor-CLI session. A provider that is merely
registered but shows `needs key` is not usable — dispatching through it would fail on
the first real call.

### With routing rules

A `RouteRule` filters candidates by capability and allow/deny lists, orders the
survivors along one axis, then appends the explicit `fallback` chain:

| `optimize` | Ordering |
| --- | --- |
| `cost` | Cheapest first, by the pricing table. |
| `latency` | Fastest first, by `config.latency`. |
| `quality` | Best first, by the `config.quality` ranking. |
| `local` | Local providers first, then cheapest within each group. |
| `explicit` | The order you named in `--allow`. CLI-only; not a config value. |

Registry order is the stable tiebreak throughout.

Inspect any decision before committing to it:

```bash
nexus route explain --optimize cost
nexus route test --optimize local 'hi'
nexus route test --optimize explicit --allow mock-flaky/mock-fast --allow mock/mock-fast --retries 1 'hi'
```

### Live failover

Failover is not just a retry loop. If a candidate produces a terminal error **before it
has streamed any real content**, the engine transparently moves to the next candidate.
Once real output has been committed, failover is disabled and the terminal event is
forwarded verbatim — NexusCode will never replay or splice a half-finished answer.

Every failover is recorded in a trail on the run's start event, so the UI and the audit
log can show exactly which providers were tried and why each was abandoned.

Cache affinity interacts with this deliberately: with `cache.affinity` on (the default),
a session prefers the provider it last used so that provider's prompt cache stays warm —
but affinity never blocks failover.

---

## Cost accounting

Every run reports usage and cost:

```
[usage] mock:mock-fast in=2 out=6 cost=$0.000000 finish=stop
```

Prices come from a table assembled as: built-in defaults for common Anthropic models,
overridden by anything in `config.pricing`. An unknown model id contributes `$0` rather
than an invented number — cost is never guessed. Local providers (`ollama`, `lmstudio`,
`vllm`, and anything on port 11434) are accounted at zero cost by construction.

Set your own prices per model, in USD per 1M tokens:

```json
{
  "pricing": {
    "gpt-4o": { "inputPer1M": 2.5, "outputPer1M": 10 },
    "llama-3.3-70b-versatile": { "inputPer1M": 0.59, "outputPer1M": 0.79 }
  }
}
```

Cache-read, cache-write, and reasoning tokens can be priced separately with
`cacheReadPer1M`, `cacheWritePer1M`, and `reasoningPer1M`.

Aggregate spend:

```bash
nexus usage --window day
nexus usage --window month --format csv
nexus history list
```

If you enable the enterprise subsystem, `enterprise.budgets` adds hard caps per
principal, role, or org, with `onExceed: "deny"` or `onExceed: "downgrade"` to a cheaper
model. It is off by default and changes nothing for single-user use.

---

## Adding a provider

Any OpenAI-compatible endpoint works with one command:

```bash
nexus providers add <id> \
  --kind <openai-compat|anthropic|gemini|bedrock|vertex|mock> \
  --adapter <package> \
  [--base-url <url>] \
  [--api-key-env <VAR>] \
  [--api-key-ref <ref>]
```

This appends an entry to your user config and prints the file it wrote. Entries you add
win over the built-in catalog for the same id, so you can also use this to override a
default provider's base URL or credential source.

Note that `kind` — not `adapter` — selects the implementation. Every `openai-compat`
entry loads the shared transport from `@nexuscode/provider-openai` regardless of the
package name you write in `adapter`.

Subprocess providers are a special case: `kind: "subprocess"` entries are served by the
default catalog (`claude-code`, `codex`) rather than constructed from config, and a
`providers[]` entry carrying a `command` is stripped from *project* config as a
workspace-trust measure. Declare those in user config.

For a genuinely new adapter — a new wire protocol — the extension point is the plugin
system (`nexus plugin list|add|info`), which registers contributions into the same engine
registries the built-ins use.

---

## See also

- **[GETTING-STARTED.md](./GETTING-STARTED.md)** — install, first run, troubleshooting.
- **[CONFIGURATION.md](./CONFIGURATION.md)** — every config key, precedence, secrets.
- **[COMMANDS.md](./COMMANDS.md)** — the complete command reference.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the adapter contract and engine design.
