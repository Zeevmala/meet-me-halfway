import { describe, it, expect } from "vitest";
import {
  countsAgainstBreaker,
  describeResourceError,
  isRetryableError,
} from "./errors";
import type { ResourceError } from "./errors";

describe("DENIED", () => {
  const denied: ResourceError = { kind: "DENIED", detail: "permission_denied" };

  // The server's answer to the same request does not change, so a retry is
  // only load — and the database that said no is healthy, so the breaker
  // must not open on it.
  it("is neither retried nor held against the breaker", () => {
    expect(isRetryableError(denied)).toBe(false);
    expect(countsAgainstBreaker(denied)).toBe(false);
  });

  it("is told apart from a network failure", () => {
    const network: ResourceError = { kind: "NETWORK", detail: "offline" };

    expect(isRetryableError(network)).toBe(true);
    expect(countsAgainstBreaker(network)).toBe(true);
    expect(describeResourceError(denied)).toBe("denied: permission_denied");
  });
});
