/**
 * StreamChunk → `UiEvent` projection (design spec §10.2). This used to be a
 * hand-copy of `packages/cli/src/ui.ts`'s projection; both now re-export the
 * single canonical fold hoisted into `@nexuscode/core` (`src/projection.ts`)
 * so the two consumer-side copies can't drift as `StreamChunk` evolves. The
 * engine emits `Labeled<StreamChunk>`; `projectLabeled` maps each into zero or
 * more `UiEvent`s that the `EventStore` appends. `@nexuscode/core`'s `UiEvent`
 * is structurally identical to this package's own `UiEvent` (`../store/events.js`),
 * so the renderer still never takes a dependency on the CLI.
 */

export { chunkToUiEvents, laneKey, projectLabeled } from "@nexuscode/core";
