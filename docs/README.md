# NexusCode documentation

NexusCode is a provider-agnostic AI CLI harness: one engine, one normalized event stream, and every model backend — hosted APIs, local models, and wrapped coding CLIs — behind a single adapter contract.

Start with the project [README](../README.md) for what NexusCode is and how to install it. These pages go deeper.

## Guides

| Document | What it covers |
| --- | --- |
| [Getting started](GETTING-STARTED.md) | Install, sign in, and run your first prompt — including the offline path that needs no API key |
| [Commands](COMMANDS.md) | Reference for all 44 `nexus` commands, their flags, and worked examples |
| [Configuration](CONFIGURATION.md) | The config file, its schema, credential storage, and every tunable option |
| [Providers](PROVIDERS.md) | Supported model backends, how each one authenticates, and their capabilities |
| [Architecture](ARCHITECTURE.md) | How the system is built: layered diagrams, the request lifecycle, the tool and agent loops, orchestration, and extension points |

## Where to go for a specific question

- **"How do I run this without an API key?"** → [Getting started](GETTING-STARTED.md). The built-in mock provider is always available, fully offline, and deterministic.
- **"What does this command do?"** → [Commands](COMMANDS.md), or `nexus <command> --help`.
- **"Where do my API keys live?"** → [Configuration](CONFIGURATION.md). Credentials resolve through an ordered chain: environment variable, OS keychain, then an encrypted local file.
- **"Which providers are supported and what can each one do?"** → [Providers](PROVIDERS.md).
- **"How does a request actually flow through the system?"** → [Request lifecycle](ARCHITECTURE.md#3-request-lifecycle-one-nexus-ask), a step-by-step sequence diagram of one `nexus ask`.
- **"How do I add a provider, a tool, an MCP server, a plugin, or a hook?"** → [Extension points](ARCHITECTURE.md#10-extension-points).
- **"How does the agent decide to call a tool, and what stops it?"** → [The agentic tool loop](ARCHITECTURE.md#4-the-agentic-tool-loop) and the permission gate table beneath it.
- **"What is the difference between compare, race, consensus, and chain?"** → [Multi-provider orchestration](ARCHITECTURE.md#6-multi-provider-orchestration).

## Diagrams

The architecture guide is diagram-first. Every diagram is a Mermaid block that GitHub renders inline:

1. [System overview](ARCHITECTURE.md#1-system-overview) — clients, the kernel, and the six subsystems
2. [Request lifecycle](ARCHITECTURE.md#3-request-lifecycle-one-nexus-ask) — one `nexus ask`, end to end
3. [Agentic tool loop](ARCHITECTURE.md#4-the-agentic-tool-loop) — tool call, gate, execute, feed back, repeat
4. [OODA agent loop](ARCHITECTURE.md#5-the-ooda-agent-loop) — observe, plan, act, evaluate, replan
5. [Multi-provider orchestration](ARCHITECTURE.md#6-multi-provider-orchestration) — compare, race, consensus, chain
6. [Context and memory pipeline](ARCHITECTURE.md#7-context-and-memory-pipeline) — sources to a budgeted, cache-stable prompt
7. [Package map](ARCHITECTURE.md#8-package-map) — how the 44 workspace packages layer
