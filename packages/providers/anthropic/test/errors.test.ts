import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { mapError } from "@nexuscode/provider-anthropic";

describe("Anthropic error mapping — account limits vs transient throttling", () => {
  it("maps depleted credits to quota_exhausted even when the API uses HTTP 400", () => {
    const error = new Anthropic.APIError(
      400,
      {
        type: "invalid_request_error",
        message: "Your credit balance is too low. Please purchase credits.",
      },
      undefined,
      undefined,
    );
    const mapped = mapError(error);
    expect(mapped.code).toBe("quota_exhausted");
    expect(mapped.retryable).toBe(false);
  });

  it("keeps ordinary HTTP 429 throttling retryable", () => {
    const error = new Anthropic.APIError(429, undefined, "Too many requests", undefined);
    const mapped = mapError(error);
    expect(mapped.code).toBe("rate_limit");
    expect(mapped.retryable).toBe(true);
  });
});
