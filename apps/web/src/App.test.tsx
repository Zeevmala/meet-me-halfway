import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("./strings", () => ({ t: (key: string) => key }));
vi.mock("./features/live-midpoint/styles/live-midpoint.css", () => ({}));

// The page is everything the agreement gates: sign-in, location, the session.
const pageMounts = vi.fn();
vi.mock("./features/live-midpoint/LiveMidpointPage", () => ({
  default: ({
    urlCode,
    initialName,
  }: {
    urlCode: string | null;
    initialName: string;
  }) => {
    pageMounts(urlCode);
    return (
      <div data-testid="page" data-name={initialName}>
        {String(urlCode)}
      </div>
    );
  },
}));

import App from "./App";

const CONSENT = "mmh:consent";
const NAME = "mmhw:displayName";

function open(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("App — nothing happens before the tap", () => {
  // The page used to sign in, ask for location and create a session as it
  // loaded: every visit, a refusing one or a crawler's included, wrote a
  // session record that is never deleted.
  it("shows the start screen and mounts nothing of the session", () => {
    open("/");

    expect(screen.getByRole("button", { name: "start.create" })).toBeTruthy();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(pageMounts).not.toHaveBeenCalled();
  });

  it("starts a session once Start is tapped", async () => {
    open("/");

    fireEvent.click(screen.getByRole("button", { name: "start.create" }));

    expect((await screen.findByTestId("page")).textContent).toBe("null");
    expect(screen.queryByRole("button", { name: "start.create" })).toBeNull();
  });

  // Opening the link was the join: a link scanner or a crawler took one of
  // four slots that are never released.
  it("shows an invitation, not a session, for a link that names one", () => {
    open("/?code=K7M2QX");

    expect(screen.getByRole("button", { name: "start.join" })).toBeTruthy();
    expect(pageMounts).not.toHaveBeenCalled();
  });

  it("joins the session the link named once Join is tapped", async () => {
    open("/?code=k7m2qx");

    fireEvent.click(screen.getByRole("button", { name: "start.join" }));

    expect((await screen.findByTestId("page")).textContent).toBe("K7M2QX");
  });
});

describe("App — the agreement is remembered per tab, per session", () => {
  // The page reloads itself: a deploy, a restore from the back/forward
  // cache, every Try again. Asked again each time, a retry was two taps.
  it("goes straight to the session on a reload of a tab that agreed", async () => {
    window.sessionStorage.setItem(CONSENT, "K7M2QX");

    open("/?code=K7M2QX");

    expect((await screen.findByTestId("page")).textContent).toBe("K7M2QX");
    expect(screen.queryByRole("button", { name: "start.join" })).toBeNull();
  });

  it("goes straight to a new session in a tab that agreed to start one", async () => {
    window.sessionStorage.setItem(CONSENT, "new");

    open("/");

    expect(await screen.findByTestId("page")).toBeTruthy();
  });

  it("records the agreement when it is given", () => {
    open("/?code=K7M2QX");

    fireEvent.click(screen.getByRole("button", { name: "start.join" }));

    expect(window.sessionStorage.getItem(CONSENT)).toBe("K7M2QX");
  });

  // Agreeing to share with one group is not agreeing to share with the next.
  it("asks again for a different session in the same tab", () => {
    window.sessionStorage.setItem(CONSENT, "K7M2QX");

    open("/?code=P3RT9W");

    expect(screen.getByRole("button", { name: "start.join" })).toBeTruthy();
    expect(pageMounts).not.toHaveBeenCalled();
  });

  it("asks again before starting a session after having joined one", () => {
    window.sessionStorage.setItem(CONSENT, "K7M2QX");

    open("/");

    expect(screen.getByRole("button", { name: "start.create" })).toBeTruthy();
    expect(pageMounts).not.toHaveBeenCalled();
  });
});

describe("App — a link that names no session", () => {
  // A code the generator could not have produced. There is nothing to agree
  // to and nothing to ask a location for: it is an invalid link, said at once.
  it("says the link is not valid, without a start screen or a session", () => {
    window.sessionStorage.setItem(CONSENT, "!!BAD");

    open("/?code=!!bad");

    expect(screen.getByText("live.sessionInvalidCode")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "start.join" })).toBeNull();
    expect(pageMounts).not.toHaveBeenCalled();
  });
});

describe("App — the name on the start screen", () => {
  it("keeps the name that was typed, and hands it to the session", async () => {
    open("/?code=K7M2QX");

    fireEvent.change(screen.getByLabelText("start.nameLabel"), {
      target: { value: "Dana" },
    });
    fireEvent.click(screen.getByRole("button", { name: "start.join" }));

    expect(window.localStorage.getItem(NAME)).toBe("Dana");
    // As a prop too: a browser that stores nothing would have lost it.
    expect((await screen.findByTestId("page")).dataset.name).toBe("Dana");
  });

  // Saving "" would store the device label as if it had been chosen.
  it("stores nothing when no name was typed", () => {
    open("/?code=K7M2QX");

    fireEvent.click(screen.getByRole("button", { name: "start.join" }));

    expect(window.localStorage.getItem(NAME)).toBeNull();
  });
});
