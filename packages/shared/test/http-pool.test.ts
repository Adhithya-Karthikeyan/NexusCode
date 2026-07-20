import { describe, it, expect, afterEach } from "vitest";
import { Agent as HttpsAgent } from "node:https";
import { Agent as HttpAgent } from "node:http";
import {
  sharedHttpsAgent,
  sharedHttpAgent,
  sharedAgentFor,
  configureHttpPool,
  httpPoolOptions,
  resetHttpPool,
  DEFAULT_MAX_SOCKETS,
} from "../src/http-pool.js";

/**
 * Connection pooling (system-spec §23): every HTTP provider adapter shares one
 * process-wide keep-alive agent so sockets are reused across calls instead of
 * re-dialed. These lock the singleton identity, the keep-alive flag, and the
 * configurable pool size.
 */
describe("shared http-pool — keep-alive connection pooling", () => {
  afterEach(() => {
    // Restore defaults so ordering never leaks tuning between tests.
    configureHttpPool({ maxSockets: DEFAULT_MAX_SOCKETS });
    resetHttpPool();
  });

  it("returns the SAME keep-alive https agent instance across calls (pooled, reused)", () => {
    const a = sharedHttpsAgent();
    const b = sharedHttpsAgent();
    expect(b).toBe(a);
    expect(a).toBeInstanceOf(HttpsAgent);
    expect(a.options.keepAlive).toBe(true);
  });

  it("returns the SAME keep-alive http agent instance across calls", () => {
    const a = sharedHttpAgent();
    const b = sharedHttpAgent();
    expect(b).toBe(a);
    expect(a).toBeInstanceOf(HttpAgent);
    expect(a.options.keepAlive).toBe(true);
  });

  it("picks the agent by URL scheme (http:// → http agent, else https)", () => {
    expect(sharedAgentFor("http://localhost:11434/v1")).toBe(sharedHttpAgent());
    expect(sharedAgentFor("https://api.openai.com/v1")).toBe(sharedHttpsAgent());
    // Undefined / unparseable → the https agent (the SDK's default host is https).
    expect(sharedAgentFor(undefined)).toBe(sharedHttpsAgent());
    expect(sharedAgentFor("::not a url::")).toBe(sharedHttpsAgent());
  });

  it("makes the pool size configurable and rebuilds the agent on change", () => {
    configureHttpPool({ maxSockets: 7 });
    expect(httpPoolOptions().maxSockets).toBe(7);
    const agent = sharedHttpsAgent();
    expect(agent.maxSockets).toBe(7);

    // A new size discards the old singleton so the next agent reflects it.
    configureHttpPool({ maxSockets: 3 });
    const next = sharedHttpsAgent();
    expect(next).not.toBe(agent);
    expect(next.maxSockets).toBe(3);
  });

  it("resetHttpPool drops the singletons so the next accessor rebuilds", () => {
    const before = sharedHttpsAgent();
    resetHttpPool();
    const after = sharedHttpsAgent();
    expect(after).not.toBe(before);
  });
});
