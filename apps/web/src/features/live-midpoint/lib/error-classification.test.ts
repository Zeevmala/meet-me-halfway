import { describe, it, expect } from "vitest";
import { classifyJoinError, describeError } from "./error-classification";

describe("classifyJoinError", () => {
  it("classifies Firebase PERMISSION_DENIED as JOIN_PERMISSION_DENIED", () => {
    expect(
      classifyJoinError({
        code: "PERMISSION_DENIED",
        message: "Client doesn't have permission to access the desired data.",
      }),
    ).toBe("JOIN_PERMISSION_DENIED");
  });

  it("classifies lowercase permission-denied", () => {
    expect(classifyJoinError({ code: "permission-denied" })).toBe(
      "JOIN_PERMISSION_DENIED",
    );
  });

  it("classifies Firebase auth/* codes as permission-denied", () => {
    expect(classifyJoinError({ code: "auth/network-request-failed" })).toBe(
      // network-request-failed wins because it's checked second?
      // Actually permission pattern matches `auth/` first — so permission.
      "JOIN_PERMISSION_DENIED",
    );
    expect(classifyJoinError({ code: "auth/user-token-expired" })).toBe(
      "JOIN_PERMISSION_DENIED",
    );
  });

  it("classifies App Check failures as permission-denied", () => {
    expect(
      classifyJoinError({
        code: "appCheck/fetch-status-error",
        message: "App Check token fetch failed",
      }),
    ).toBe("JOIN_PERMISSION_DENIED");
  });

  it("classifies unavailable as network error", () => {
    expect(classifyJoinError({ code: "unavailable" })).toBe(
      "JOIN_NETWORK_ERROR",
    );
  });

  it("classifies TypeError: Failed to fetch as network error", () => {
    expect(classifyJoinError(new TypeError("Failed to fetch"))).toBe(
      "JOIN_NETWORK_ERROR",
    );
  });

  it("classifies generic offline error as network error", () => {
    expect(classifyJoinError({ message: "Client is offline" })).toBe(
      "JOIN_NETWORK_ERROR",
    );
  });

  it("falls back to JOIN_FAILED for unknown errors", () => {
    expect(classifyJoinError(new Error("Something weird"))).toBe("JOIN_FAILED");
    expect(classifyJoinError(null)).toBe("JOIN_FAILED");
    expect(classifyJoinError(undefined)).toBe("JOIN_FAILED");
    expect(classifyJoinError("string error")).toBe("JOIN_FAILED");
  });
});

describe("describeError", () => {
  it("combines code and message when both present", () => {
    expect(
      describeError({ code: "PERMISSION_DENIED", message: "no access" }),
    ).toBe("PERMISSION_DENIED: no access");
  });

  it("returns just the code when no message", () => {
    expect(describeError({ code: "unavailable" })).toBe("unavailable");
  });

  it("returns just the message when no code", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("returns a generic string for null/undefined", () => {
    expect(describeError(null)).toBe("Unknown error");
    expect(describeError(undefined)).toBe("Unknown error");
  });

  it("returns the constructor name when nothing else is available", () => {
    expect(describeError({ name: "WeirdError" })).toBe("WeirdError");
  });
});
