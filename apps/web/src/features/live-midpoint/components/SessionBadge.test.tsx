import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";

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
import type { SessionPhase } from "../graph/types";
import type { ParticipantIndex } from "../lib/participant-config";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      canInvite: boolean;
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
        canInvite={overrides.canInvite ?? true}
        participants={
          overrides.participants ?? [{ index: 1, connected: false, name: null }]
        }
      />,
    );

  it("renders session code", () => {
    renderBadge();
    expect(screen.getByText(CODE)).toBeTruthy();
  });

  describe("invite", () => {
    // The e2e suite reads the code off .live-badge-code: nothing else in it.
    it("makes the code the invite button, holding just the code", () => {
      const { container } = renderBadge();
      const button = screen.getByRole("button", {
        name: `live.inviteCode:{"code":"${CODE}"}`,
      });
      expect(button.querySelector(".live-badge-code")?.textContent).toBe(CODE);
      expect(container.querySelectorAll(".live-badge-code")).toHaveLength(1);
    });

    it("opens the share sheet with the session link where there is one", async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", {
        ...navigator,
        share,
        canShare: () => true,
      });
      renderBadge();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /inviteCode/ }));
      });

      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${window.location.origin}?code=${CODE}`,
        }),
      );
    });

    it("copies the link where there is no share sheet, and says so", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      renderBadge();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /inviteCode/ }));
      });

      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}?code=${CODE}`,
      );
      expect(screen.getByRole("status").textContent).toBe("live.linkCopied");
    });

    // A closed share sheet is the user's answer, not a failure to recover from.
    it("does nothing more when the share sheet is dismissed", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", {
        ...navigator,
        share: vi.fn().mockRejectedValue(new DOMException("", "AbortError")),
        canShare: () => true,
        clipboard: { writeText },
      });
      renderBadge();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /inviteCode/ }));
      });

      expect(writeText).not.toHaveBeenCalled();
    });

    it("shows the code but no invite once all five slots are taken", () => {
      renderBadge({ canInvite: false });
      expect(screen.getByText(CODE)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /inviteCode/ })).toBeNull();
    });
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
        canInvite
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
        canInvite
        participants={[]}
      />,
    );

    const ownPillAfter = container.querySelector(".live-pill .live-pill-dot")!;
    expect(ownPillAfter.classList.contains("live-pill-dot--gray")).toBe(true);
  });

  it("renders own pill showing the chosen name", () => {
    renderBadge({ ownName: "zeev" });
    const btn = screen.getByLabelText("live.editName") as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toContain("zeev");
  });

  it("shows 'You' for an empty ownName", () => {
    renderBadge({ ownName: "" });
    const btn = screen.getByLabelText("live.editName") as HTMLButtonElement;
    expect(btn.textContent).toContain("live.you");
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
        canInvite
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
