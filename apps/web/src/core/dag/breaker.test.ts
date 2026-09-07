import { describe, it, expect } from "vitest";
import { createBreaker } from "./breaker";
import type { BreakerConfig } from "./breaker";

const CONFIG: BreakerConfig = {
  failureThreshold: 3,
  baseOpenMs: 1000,
  maxOpenMs: 8000,
  multiplier: 2,
};

describe("createBreaker", () => {
  it("starts closed and admits calls", () => {
    const b = createBreaker(CONFIG);
    expect(b.state()).toBe("closed");
    expect(b.allow(0)).toBe(true);
    expect(b.retryAtMs()).toBe(0);
  });

  it("stays closed below the failure threshold", () => {
    const b = createBreaker(CONFIG);
    b.recordFailure(0);
    b.recordFailure(0);
    expect(b.state()).toBe("closed");
    expect(b.allow(0)).toBe(true);
  });

  it("opens on the threshold failure and refuses calls", () => {
    const b = createBreaker(CONFIG);
    for (let i = 0; i < 3; i++) b.recordFailure(100);
    expect(b.state()).toBe("open");
    expect(b.allow(100)).toBe(false);
    expect(b.retryAtMs()).toBe(1100);
  });

  it("resets the failure count on success", () => {
    const b = createBreaker(CONFIG);
    b.recordFailure(0);
    b.recordFailure(0);
    b.recordSuccess();
    b.recordFailure(0);
    expect(b.state()).toBe("closed");
  });

  it("admits exactly one probe once the cooldown elapses", () => {
    const b = createBreaker(CONFIG);
    for (let i = 0; i < 3; i++) b.recordFailure(0);

    expect(b.allow(999)).toBe(false);
    expect(b.allow(1000)).toBe(true);
    expect(b.state()).toBe("halfOpen");
    // A second concurrent caller must not also get through.
    expect(b.allow(1000)).toBe(false);
  });

  it("closes when the probe succeeds", () => {
    const b = createBreaker(CONFIG);
    for (let i = 0; i < 3; i++) b.recordFailure(0);
    b.allow(1000);
    b.recordSuccess();

    expect(b.state()).toBe("closed");
    expect(b.allow(1000)).toBe(true);
  });

  it("doubles the cooldown when the probe fails, up to the ceiling", () => {
    const b = createBreaker(CONFIG);
    for (let i = 0; i < 3; i++) b.recordFailure(0);
    expect(b.retryAtMs()).toBe(1000);

    b.allow(1000);
    b.recordFailure(1000);
    expect(b.retryAtMs()).toBe(1000 + 2000);

    b.allow(3000);
    b.recordFailure(3000);
    expect(b.retryAtMs()).toBe(3000 + 4000);

    b.allow(7000);
    b.recordFailure(7000);
    expect(b.retryAtMs()).toBe(7000 + 8000);

    // Capped at maxOpenMs.
    b.allow(15000);
    b.recordFailure(15000);
    expect(b.retryAtMs()).toBe(15000 + 8000);
  });

  it("resets the cooldown to base after recovering", () => {
    const b = createBreaker(CONFIG);
    for (let i = 0; i < 3; i++) b.recordFailure(0);
    b.allow(1000);
    b.recordFailure(1000); // cooldown now 2000
    b.allow(3000);
    b.recordSuccess();

    for (let i = 0; i < 3; i++) b.recordFailure(4000);
    expect(b.retryAtMs()).toBe(5000);
  });
});
