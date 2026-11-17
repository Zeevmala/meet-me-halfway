import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../strings", () => ({ t: (key: string) => key }));
vi.mock("../styles/live-midpoint.css", () => ({}));

import StartScreen from "./StartScreen";

beforeEach(() => {
  window.localStorage.clear();
});

describe("StartScreen", () => {
  it("says what starting a session does, and offers to start one", () => {
    render(<StartScreen joining={false} onStart={vi.fn()} />);

    expect(screen.getByText("start.createLead")).toBeTruthy();
    expect(screen.getByRole("button", { name: "start.create" })).toBeTruthy();
    expect(screen.queryByText("start.joinLead")).toBeNull();
  });

  it("says it is an invitation, and offers to join, when the link named a session", () => {
    render(<StartScreen joining onStart={vi.fn()} />);

    expect(screen.getByText("start.joinLead")).toBeTruthy();
    expect(screen.getByRole("button", { name: "start.join" })).toBeTruthy();
    expect(screen.queryByText("start.createLead")).toBeNull();
  });

  // What is shared, with whom, and how it stops: before the location prompt,
  // not in a policy nobody had been shown.
  it("says who sees the location and how sharing stops", () => {
    render(<StartScreen joining onStart={vi.fn()} />);

    expect(screen.getByText("start.pointShare")).toBeTruthy();
    expect(screen.getByText("start.pointStop")).toBeTruthy();
    expect(screen.getByRole("link", { name: "live.privacy" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "live.terms" })).toBeTruthy();
  });

  it("does nothing until the button is tapped", () => {
    const onStart = vi.fn();
    render(<StartScreen joining={false} onStart={onStart} />);

    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "start.create" }));

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("hands over the name that was typed, trimmed", () => {
    const onStart = vi.fn();
    render(<StartScreen joining onStart={onStart} />);

    fireEvent.change(screen.getByLabelText("start.nameLabel"), {
      target: { value: "  Dana " },
    });
    fireEvent.click(screen.getByRole("button", { name: "start.join" }));

    expect(onStart).toHaveBeenCalledWith("Dana");
  });

  it("hands over no name when none was typed", () => {
    const onStart = vi.fn();
    render(<StartScreen joining onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: "start.join" }));

    expect(onStart).toHaveBeenCalledWith("");
  });

  it("starts on Enter in the name field", () => {
    const onStart = vi.fn();
    render(<StartScreen joining={false} onStart={onStart} />);
    const field = screen.getByLabelText("start.nameLabel");

    fireEvent.change(field, { target: { value: "Dana" } });
    fireEvent.submit(field);

    expect(onStart).toHaveBeenCalledWith("Dana");
  });

  it("offers back a name chosen before", () => {
    window.localStorage.setItem("mmhw:displayName", "Dana");

    render(<StartScreen joining onStart={vi.fn()} />);

    expect(
      (screen.getByLabelText("start.nameLabel") as HTMLInputElement).value,
    ).toBe("Dana");
  });

  // "Linux" here, "iPhone" on a phone: the label the app falls back on is
  // not something they typed, and must not be shown as if it were.
  it("does not offer the device label as a name", () => {
    const realUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      configurable: true,
    });
    // What the session stores for a phone whose owner never typed a name.
    window.localStorage.setItem("mmhw:displayName", "iPhone");
    try {
      render(<StartScreen joining onStart={vi.fn()} />);

      expect(
        (screen.getByLabelText("start.nameLabel") as HTMLInputElement).value,
      ).toBe("");
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        value: realUA,
        configurable: true,
      });
    }
  });
});
