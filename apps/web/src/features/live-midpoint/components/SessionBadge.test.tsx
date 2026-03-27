import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
      participants: Array<{ index: ParticipantIndex; connected: boolean }>;
    }> = {},
  ) =>
    render(
      <SessionBadge
        code={overrides.code ?? CODE}
        phase={overrides.phase ?? "waiting"}
        ownConnected={overrides.ownConnected ?? false}
        ownIndex={overrides.ownIndex ?? 0}
        participants={overrides.participants ?? [{ index: 1, connected: false }]}
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
        participants={[]}
      />,
    );

    const ownPillAfter = container.querySelector(".live-pill .live-pill-dot")!;
    expect(ownPillAfter.classList.contains("live-pill-dot--gray")).toBe(true);
  });

  it("participant pills use correct color classes", () => {
    const { container } = render(
      <SessionBadge
        code={CODE}
        phase="connected"
        ownConnected={true}
        ownIndex={0}
        participants={[
          { index: 1, connected: true },
          { index: 2, connected: false },
        ]}
      />,
    );

    const pills = container.querySelectorAll(".live-pill .live-pill-dot");
    // pills[0] is own, pills[1] is participant 1, pills[2] is participant 2
    expect(pills[1]!.classList.contains("live-pill-dot--p1")).toBe(true);
    expect(pills[2]!.classList.contains("live-pill-dot--gray")).toBe(true);
  });
});
