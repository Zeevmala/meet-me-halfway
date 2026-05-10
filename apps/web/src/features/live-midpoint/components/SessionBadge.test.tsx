import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

vi.mock("../styles/live-midpoint.css", () => ({}));

import SessionBadge from "./SessionBadge";
import type { SessionPhase } from "../hooks/useLiveSession";
import type { ParticipantIndex } from "../lib/participant-config";

describe("SessionBadge", () => {
  const CODE = "XYZ789";

  const renderBadge = (
    overrides: Partial<{
      code: string;
      phase: SessionPhase;
      ownConnected: boolean;
      ownIndex: ParticipantIndex;
      ownName: string;
      onNameChange: (name: string) => void;
      participants: Array<{
        index: ParticipantIndex;
        connected: boolean;
        name: string | null;
      }>;
    }> = {},
  ) =>
    render(
      <SessionBadge
        code={overrides.code ?? CODE}
        phase={overrides.phase ?? "waiting"}
        ownConnected={overrides.ownConnected ?? false}
        ownIndex={overrides.ownIndex ?? 0}
        ownName={overrides.ownName ?? "Mac"}
        onNameChange={overrides.onNameChange ?? vi.fn()}
        participants={
          overrides.participants ?? [{ index: 1, connected: false, name: null }]
        }
      />,
    );

  it("renders session code", () => {
    renderBadge();
    expect(screen.getByText(CODE)).toBeTruthy();
  });

  it('shows live dot when phase is "connected"', () => {
    renderBadge({ phase: "connected" });
    expect(screen.queryByLabelText("live.liveIndicator")).toBeTruthy();
  });

  it('shows live dot when phase is "some_stale"', () => {
    renderBadge({ phase: "some_stale" as SessionPhase });
    expect(screen.queryByLabelText("live.liveIndicator")).toBeTruthy();
  });

  it('hides live dot when phase is "waiting"', () => {
    renderBadge({ phase: "waiting" });
    expect(screen.queryByLabelText("live.liveIndicator")).toBeNull();
  });

  it("own pill uses participant color class when connected, gray when not", () => {
    const { container, rerender } = render(
      <SessionBadge
        code={CODE}
        phase="connected"
        ownConnected={true}
        ownIndex={0}
        ownName="Mac"
        onNameChange={vi.fn()}
        participants={[]}
      />,
    );

    const ownPill = container.querySelector(".live-pill .live-pill-dot")!;
    expect(ownPill.classList.contains("live-pill-dot--p0")).toBe(true);

    rerender(
      <SessionBadge
        code={CODE}
        phase="connected"
        ownConnected={false}
        ownIndex={0}
        ownName="Mac"
        onNameChange={vi.fn()}
        participants={[]}
      />,
    );

    const ownPillAfter = container.querySelector(".live-pill .live-pill-dot")!;
    expect(ownPillAfter.classList.contains("live-pill-dot--gray")).toBe(true);
  });

  it("renders own pill as a single uppercase first letter of ownName", () => {
    renderBadge({ ownName: "zeev" });
    const btn = screen.getByLabelText("live.editName") as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toContain("Z");
  });

  it("falls back to '?' for empty ownName", () => {
    renderBadge({ ownName: "" });
    const btn = screen.getByLabelText("live.editName") as HTMLButtonElement;
    expect(btn.textContent).toContain("?");
  });

  it("shows first letter for named participants and index for unnamed", () => {
    const { container } = render(
      <SessionBadge
        code={CODE}
        phase="connected"
        ownConnected={true}
        ownIndex={0}
        ownName="Zeev"
        onNameChange={vi.fn()}
        participants={[
          { index: 1, connected: true, name: "Alex" },
          { index: 2, connected: false, name: null },
        ]}
      />,
    );

    const pills = container.querySelectorAll("div.live-pill");
    expect(pills.length).toBe(2);
    expect(pills[0]!.textContent).toContain("A");
    expect(pills[1]!.textContent).toContain("3");
  });

  it("clicking own pill opens an input pre-filled with ownName", () => {
    renderBadge({ ownName: "Zeev" });
    fireEvent.click(screen.getByLabelText("live.editName"));
    const input = screen.getByLabelText("live.editName") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("Zeev");
  });

  it("Enter commits a new name and calls onNameChange", () => {
    const onNameChange = vi.fn();
    renderBadge({ ownName: "Mac", onNameChange });
    fireEvent.click(screen.getByLabelText("live.editName"));
    const input = screen.getByLabelText("live.editName") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Zeev  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNameChange).toHaveBeenCalledWith("Zeev");
  });

  it("Escape cancels without calling onNameChange", () => {
    const onNameChange = vi.fn();
    renderBadge({ ownName: "Mac", onNameChange });
    fireEvent.click(screen.getByLabelText("live.editName"));
    const input = screen.getByLabelText("live.editName") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Other" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onNameChange).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("live.editName") as HTMLElement).tagName,
    ).toBe("BUTTON");
  });

  it("does not call onNameChange when committed value is empty or unchanged", () => {
    const onNameChange = vi.fn();
    renderBadge({ ownName: "Mac", onNameChange });
    fireEvent.click(screen.getByLabelText("live.editName"));
    const input = screen.getByLabelText("live.editName") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNameChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("live.editName"));
    const input2 = screen.getByLabelText("live.editName") as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "Mac" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(onNameChange).not.toHaveBeenCalled();
  });
});
