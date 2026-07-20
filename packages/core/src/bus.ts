/**
 * The in-process event bus & fan-out merge (the mesh contract seam). Takes
 * per-run async generators and produces one ordered, labeled stream. `seq` is
 * stamped BY THE BUS on publish — a single monotonic counter across all lanes —
 * so the merged/persisted timeline has a total order even when concurrent runs
 * interleave. Swapping this one file for a Redis-Streams driver is the only
 * change needed to graduate to out-of-process workers.
 */

import type { StreamChunk } from "@nexuscode/shared";

export interface Labeled<T> {
  runId: string;
  laneIndex: number;
  /** Monotonic sequence stamped by the bus on publish. */
  seq: number;
  chunk: T;
}

export interface PublishOptions {
  runId: string;
  /** Pane index for compare/race; 0 (or "main") for single runs. */
  laneIndex?: number;
}

export interface Bus {
  /** Label a source stream, stamping a monotonic `seq` on every chunk. */
  publish(
    source: AsyncIterable<StreamChunk>,
    opts: PublishOptions,
  ): AsyncIterable<Labeled<StreamChunk>>;
  /** Merge N labeled streams into one, applying uniform backpressure. */
  merge(
    streams: Array<AsyncIterable<Labeled<StreamChunk>>>,
  ): AsyncIterable<Labeled<StreamChunk>>;
}

/**
 * Hand-rolled fan-in merge with no RxJS tax. Pulls from every iterator
 * concurrently and yields whichever chunk is ready first; a slow consumer
 * applies backpressure uniformly because we only re-pull a lane after its
 * previous value has been yielded.
 */
export async function* mergeAsyncIterables<T>(
  streams: Array<AsyncIterable<T>>,
): AsyncIterable<T> {
  const iterators = streams.map((s) => s[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>();

  const pull = (index: number): void => {
    const it = iterators[index];
    if (!it) return;
    pending.set(
      index,
      it.next().then((result) => ({ index, result })),
    );
  };

  iterators.forEach((_, i) => pull(i));

  try {
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      if (result.done) {
        pending.delete(index);
        continue;
      }
      yield result.value;
      pull(index);
    }
  } finally {
    // Best-effort close of any iterators still open (early consumer break).
    await Promise.allSettled(
      iterators.map((it) => (it.return ? it.return() : Promise.resolve(undefined))),
    );
  }
}

export class InProcessBus implements Bus {
  private seq = 0;

  async *publish(
    source: AsyncIterable<StreamChunk>,
    opts: PublishOptions,
  ): AsyncIterable<Labeled<StreamChunk>> {
    const laneIndex = opts.laneIndex ?? 0;
    for await (const chunk of source) {
      yield { runId: opts.runId, laneIndex, seq: this.seq++, chunk };
    }
  }

  merge(
    streams: Array<AsyncIterable<Labeled<StreamChunk>>>,
  ): AsyncIterable<Labeled<StreamChunk>> {
    return mergeAsyncIterables(streams);
  }
}

export function createBus(): Bus {
  return new InProcessBus();
}
