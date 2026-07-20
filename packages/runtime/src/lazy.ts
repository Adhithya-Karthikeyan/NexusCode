/**
 * Lazy subsystem construction for the runtime bootstrap (system-spec §23: lazy
 * loading). Startup — and especially a one-shot `nexus ask` — must stay fast, so
 * heavy subsystems (the RAG index, LSP servers, the `tools-*` groups, the REST
 * server) are NOT built when the runtime is assembled. Each is registered as a
 * factory and constructed only on first access, then memoized for the rest of
 * the process.
 *
 * The factories are injected (the runtime package never build-couples to those
 * heavy packages), so this stays a tiny, dependency-free memoization primitive.
 */

/** A memoized single value built on first {@link Lazy.get}. */
export interface Lazy<T> {
  /** Build (once) and return the value. */
  get(): T;
  /** True once {@link get} has run. */
  readonly loaded: boolean;
  /** Peek without constructing — `undefined` until first access. */
  peek(): T | undefined;
  /** Drop the built value so the next {@link get} rebuilds (tests / reload). */
  reset(): void;
}

/** Wrap `factory` so it runs at most once, on the first {@link Lazy.get}. */
export function lazy<T>(factory: () => T): Lazy<T> {
  let built = false;
  let value: T | undefined;
  return {
    get(): T {
      if (!built) {
        value = factory();
        built = true;
      }
      return value as T;
    },
    get loaded(): boolean {
      return built;
    },
    peek(): T | undefined {
      return value;
    },
    reset(): void {
      built = false;
      value = undefined;
    },
  };
}

/** An async variant that memoizes the resolved value (and shares the in-flight promise). */
export interface LazyAsync<T> {
  get(): Promise<T>;
  readonly loaded: boolean;
  reset(): void;
}

/** Wrap an async `factory` so it runs at most once; concurrent callers share the promise. */
export function lazyAsync<T>(factory: () => Promise<T>): LazyAsync<T> {
  let promise: Promise<T> | undefined;
  let done = false;
  return {
    async get(): Promise<T> {
      if (!promise) {
        promise = factory().then((v) => {
          done = true;
          return v;
        });
      }
      return promise;
    },
    get loaded(): boolean {
      return done;
    },
    reset(): void {
      promise = undefined;
      done = false;
    },
  };
}

/**
 * A named registry of lazily-constructed subsystems. The runtime hands one of
 * these to clients; the CLI/SDK register factories that `import()` and build the
 * heavy pieces, and nothing is constructed until {@link get} is first called for
 * that name — so `ask` never spins up the RAG index or an LSP server it won't use.
 */
export class LazySubsystems {
  private readonly cells = new Map<string, Lazy<unknown>>();

  /**
   * Register a subsystem factory under `name`. Idempotent per name: a second
   * registration for the same name is ignored (the first factory wins) so a
   * re-bootstrap never silently discards an already-built subsystem.
   */
  register<T>(name: string, factory: () => T): this {
    if (!this.cells.has(name)) this.cells.set(name, lazy(factory) as Lazy<unknown>);
    return this;
  }

  /** True when a factory is registered for `name`. */
  has(name: string): boolean {
    return this.cells.has(name);
  }

  /** Construct (once) and return the named subsystem. Throws if `name` is unknown. */
  get<T>(name: string): T {
    const cell = this.cells.get(name);
    if (!cell) throw new Error(`lazy subsystem "${name}" is not registered`);
    return cell.get() as T;
  }

  /** True once the named subsystem has actually been constructed. */
  isLoaded(name: string): boolean {
    return this.cells.get(name)?.loaded ?? false;
  }

  /** Every registered subsystem name. */
  names(): string[] {
    return [...this.cells.keys()];
  }

  /** Names of the subsystems that have actually been constructed so far. */
  loadedNames(): string[] {
    return [...this.cells.entries()].filter(([, c]) => c.loaded).map(([n]) => n);
  }

  /** Drop a built subsystem so it is rebuilt on next access (tests / reload). */
  reset(name?: string): void {
    if (name) this.cells.get(name)?.reset();
    else for (const c of this.cells.values()) c.reset();
  }
}
