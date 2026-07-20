/**
 * `UiEvent` — the CLI/TUI projection of the engine's `StreamChunk` union
 * (plan §6.2). Every command produces the *same* normalized `UiEvent` stream;
 * the text/json/ndjson renderers are pure functions over it. `--output ndjson`
 * is the public wrap contract, so its shape is stable.
 *
 * The projection itself (`UiEvent` + `chunkToUiEvents`/`laneKey`/`projectLabeled`)
 * is hoisted into `@nexuscode/core` so it can't drift from the TUI's copy
 * (`@nexuscode/tui`'s `bridge/project.ts`); this file just re-exports it so
 * existing imports from `./ui.js` keep working.
 */

export {
  chunkToUiEvents,
  laneKey,
  projectLabeled,
  type UiEvent,
  type UiEventType,
} from "@nexuscode/core";
