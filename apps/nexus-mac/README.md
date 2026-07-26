# NexusCode for macOS

A native macOS app that drives the `nexus` CLI. Not a second implementation of
it — a control surface over it.

## The rule

**Anything the app can do must exist as a `nexus` command first.**

The app spawns commands and renders the events they emit. It never talks to a
provider, holds a credential, or decides anything about a run. Two consequences,
both deliberate:

- A feature cannot exist in the app without existing in the terminal. When
  something feels missing here, the fix lands in the CLI — and the terminal gets
  it too.
- The composer always displays the exact invocation it will run
  (`nexus ask … -o ndjson`). The UI can never become a black box relative to the
  CLI.

## How it works

```
nexus <cmd> -o ndjson  ──stdout──▶  UiEvent  ──▶  ViewState.reduce  ──▶  SwiftUI
```

- **`UiEvent`** mirrors the TypeScript union in `packages/core/src/projection.ts`.
  Unknown event types and malformed lines survive as `.unknown` rather than being
  dropped, so a newer CLI degrades gracefully instead of silently truncating what
  the user sees.
- **`ViewState`** is a port of `packages/tui/src/store/viewState.ts` — a pure
  `(state, event, ts) -> state` fold that never reads the clock. Replaying a log
  therefore rebuilds byte-identical state, which is what lets a past session be
  re-opened through the *same* code path as a live one (`nexus replay <id>`).
- **`NexusClient`** is the process bridge: line-buffered stdout (a split JSON
  object is never decoded mid-object), stderr surfaced as diagnostics rather than
  swallowed, and cancellation that terminates the child.
- **OMC integration** reads `.omc/state/` read-only to show what
  oh-my-claudecode's subagents are doing.

## Layout

| Path | Contents |
|---|---|
| `Sources/NexusKit` | All logic — events, fold, process bridge, OMC, themes. Headlessly testable. |
| `Sources/NexusApp` | SwiftUI only. No business logic. |
| `Sources/NexusKit/Generated` | Generated; do not hand-edit. |
| `tools/` | Code generation and bundling. |

Presentation logic (command construction, agent-row derivation) lives in
`NexusKit` specifically so it can be tested without a window.

## Themes

The 16 palettes and their 74 semantic tokens are **generated** from
`packages/theme`, the same source the terminal renders from — so picking
"Nexus Noir" in either gives identical colours.

```sh
node tools/generate-themes.mjs   # after changing packages/theme
```

No view names a raw colour; every visual role is a token. That is what lets all
16 themes work without any view knowing they exist.

## Build & run

```sh
swift build          # library + executable
swift test           # 60+ tests, incl. live tests against the real CLI
./tools/bundle.sh    # -> .build/NexusCode.app
open .build/NexusCode.app
```

`swift test` includes integration tests that spawn the real `nexus` binary using
the offline `mock` provider — no credentials, no network. They **skip** rather
than fail when the CLI has not been built, so a fresh clone still runs green.

## Notes for contributors

- The `UiEvent` contract is guarded by `UiEventDecodingTests`, which decodes a
  fixture containing every variant. If the CLI renames a field, that test fails
  loudly instead of the app quietly rendering an empty panel.
- OMC fixtures are copied verbatim from a real session. That matters: real data
  revealed that most registry rows are reconstructed placeholders
  (`synthetic: true`), that the file's own roll-up counters disagree with its
  array, and that agent status is not monotonic. Synthetic fixtures would have
  hidden all three.
- Swift 6 strict concurrency is on. Keep model types value types and `Sendable`.
