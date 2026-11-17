import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../../strings", () => ({ t: (key: string) => key }));
vi.mock("../styles/live-midpoint.css", () => ({}));

import LegalLinks from "./LegalLinks";

describe("LegalLinks", () => {
  it("links the privacy policy, the terms and the source", () => {
    render(<LegalLinks />);

    expect(
      screen.getByRole("link", { name: "live.privacy" }).getAttribute("href"),
    ).toBe("/privacy");
    expect(
      screen.getByRole("link", { name: "live.terms" }).getAttribute("href"),
    ).toBe("/terms");
    expect(
      screen.getByRole("link", { name: "live.github" }).getAttribute("href"),
    ).toContain("github.com");
  });

  // Followed in place, they unloaded the page — tearing down the session
  // listener and GPS — and Back restored it frozen.
  it("opens every one in a new tab, keeping the session", () => {
    render(<LegalLinks />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  it("is a named landmark", () => {
    render(<LegalLinks />);

    expect(
      screen.getByRole("navigation", { name: "live.legalLabel" }),
    ).toBeTruthy();
  });
});
