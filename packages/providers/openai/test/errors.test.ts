import { describe, it, expect } from "vitest";
import { APIError } from "openai";
import { mapOpenAIError, redactSecrets } from "@nexuscode/provider-openai";

/**
 * A backend (esp. OpenAI-compatible proxies) can echo the offending credential
 * verbatim in a 401/403 error body — that string must never survive into the
 * normalized `AdapterError.message` that gets logged / shown in the TUI.
 */
describe("mapOpenAIError — secret redaction", () => {
  it("masks a fake sk- style API key embedded in a 401 error body", () => {
    const err = new APIError(
      401,
      { message: "Invalid API key provided: sk-ABC123456789DEF" },
      undefined,
      undefined,
    );
    const adapterError = mapOpenAIError(err, "openai");
    expect(adapterError.code).toBe("auth");
    expect(adapterError.message).not.toContain("sk-ABC123456789DEF");
    expect(adapterError.message).toContain("***");
  });

  it("masks a Bearer token echoed into an error message", () => {
    const err = new APIError(
      403,
      { message: "Forbidden — Bearer sk-live-someRealToken1234 is not authorized" },
      undefined,
      undefined,
    );
    const adapterError = mapOpenAIError(err, "openai");
    expect(adapterError.message).not.toContain("someRealToken1234");
    expect(adapterError.message).toContain("Bearer ***");
  });

  it("leaves ordinary error text untouched", () => {
    const err = new APIError(400, { message: "model not found" }, undefined, undefined);
    const adapterError = mapOpenAIError(err, "openai");
    expect(adapterError.message).toContain("model not found");
  });
});

describe("redactSecrets", () => {
  it("masks known provider key prefixes", () => {
    expect(redactSecrets("key=xai-abcdef123456")).not.toContain("abcdef123456");
    expect(redactSecrets("key=gsk-abcdef123456")).toContain("***");
    expect(redactSecrets("key=nvapi-abcdef123456")).toContain("***");
    expect(redactSecrets("key=or-abcdef123456")).toContain("***");
  });

  it("masks a Bearer header value", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer ***");
  });
});
