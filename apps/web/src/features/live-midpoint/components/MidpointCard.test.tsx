import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

vi.mock("../styles/live-midpoint.css", () => ({}));

import MidpointCard from "./MidpointCard";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import type { RouteInfo } from "../graph/types";
import type { ParticipantIndex } from "../lib/participant-config";

const ownPosition: LatLng = { lat: 32.08, lng: 34.78 };
const otherPosition: LatLng = { lat: 31.77, lng: 35.21 };
// A venue off to one side, as a picked one usually is. The straight-line
// fallback must measure to it rather than to the midpoint, and only a fixture
// that gives all four distances different values can tell the two apart.
const midpoint: LatLng = { lat: 31.95, lng: 34.85 };
const destination: LatLng = { lat: 31.85, lng: 35.15 };

const dummyGeometry: GeoJSON.LineString = {
  type: "LineString",
  coordinates: [
    [34.78, 32.08],
    [34.995, 31.925],
  ],
};

const ownRoute: RouteInfo = {
  distance: 42000,
  duration: 2400,
  geometry: dummyGeometry,
};
const otherRoute: RouteInfo = {
  distance: 38000,
  duration: 2100,
  geometry: dummyGeometry,
};

interface OtherParticipant {
  index: ParticipantIndex;
  route: RouteInfo | null;
  position: LatLng;
  stale: boolean;
  name: string | null;
}

function renderCard(
  overrides: Partial<Parameters<typeof MidpointCard>[0]> = {},
) {
  const defaults = {
    ownIndex: 0 as ParticipantIndex,
    ownPosition,
    ownRoute: null as RouteInfo | null,
    otherParticipants: [
      {
        index: 1 as ParticipantIndex,
        route: null,
        position: otherPosition,
        stale: false,
        name: null,
      },
    ] as OtherParticipant[],
    destination,
    travelProfile: "driving" as const,
    onProfileChange: vi.fn(),
    selectedVenueName: null as string | null,
    routesStale: false,
  };
  return render(<MidpointCard {...defaults} {...overrides} />);
}

/** The rows of the arrival list, in order, as the eye reads them. */
function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

describe("MidpointCard", () => {
  it("lists you first, then the others, with straight-line distances until routes arrive", () => {
    renderCard();

    const [own, other] = rows();
    expect(within(own!).getByText("live.you")).toBeTruthy();
    expect(within(other!).getByText('live.participant:{"n":2}')).toBeTruthy();
    expect(
      within(own!).getByText(
        formatDistance(haversineDistance(ownPosition, destination)),
      ),
    ).toBeTruthy();
    expect(
      within(other!).getByText(
        formatDistance(haversineDistance(otherPosition, destination)),
      ),
    ).toBeTruthy();
    // No route, no time: a placeholder, not a guess.
    expect(within(own!).getByText("—")).toBeTruthy();
  });

  it("names each person in full", () => {
    renderCard({
      otherParticipants: [
        {
          index: 1 as ParticipantIndex,
          route: null,
          position: otherPosition,
          stale: false,
          name: "Alexandra",
        },
      ],
    });

    expect(within(rows()[1]!).getByText("Alexandra")).toBeTruthy();
  });

  // The stale note used to be a red block at the top of the card, away from
  // the person it was about.
  it("tags a stale participant on their own row, with one hint below", () => {
    renderCard({
      otherParticipants: [
        {
          index: 1 as ParticipantIndex,
          route: null,
          position: otherPosition,
          stale: true,
          name: null,
        },
      ],
    });

    const other = rows()[1]!;
    expect(other.classList).toContain("live-eta-row--stale");
    expect(within(other).getByText("live.staleTag")).toBeTruthy();
    expect(within(rows()[0]!).queryByText("live.staleTag")).toBeNull();
    expect(screen.getByText("live.participantStaleHint")).toBeTruthy();
  });

  it("says nothing about staleness when everyone is current", () => {
    renderCard();

    expect(screen.queryByText("live.staleTag")).toBeNull();
    expect(screen.queryByText("live.participantStaleHint")).toBeNull();
  });

  it("titles the card with the venue when one is picked, else the midpoint", () => {
    const { unmount } = renderCard();
    expect(screen.getByText("live.midpoint")).toBeTruthy();
    unmount();

    renderCard({ selectedVenueName: "Cafe Roma" });
    expect(screen.getByText('live.meetAt:{"name":"Cafe Roma"}')).toBeTruthy();
  });

  it("driving/walking toggle calls onProfileChange", () => {
    const onProfileChange = vi.fn();
    renderCard({ onProfileChange, travelProfile: "driving" });

    const mode = screen.getByRole("group", { name: "live.travelMode" });
    expect(
      within(mode).getByText("live.driving").getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(within(mode).getByText("live.walking"));
    expect(onProfileChange).toHaveBeenCalledWith("walking");

    fireEvent.click(within(mode).getByText("live.driving"));
    expect(onProfileChange).toHaveBeenCalledWith("driving");
  });

  // Short visible labels; the accessible names still say what they do, and
  // contain the visible text (WCAG 2.5.3).
  it("nav links contain correct Waze and Google Maps URLs", () => {
    renderCard();

    const wazeAnchor = screen.getByRole("link", { name: "live.navigateWaze" });
    const googleAnchor = screen.getByRole("link", {
      name: "live.navigateGoogle",
    });

    expect(wazeAnchor.textContent).toBe("live.waze");
    expect(googleAnchor.textContent).toBe("live.googleMaps");
    expect(wazeAnchor.getAttribute("href")).toBe(
      `https://waze.com/ul?ll=${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}&navigate=yes`,
    );
    expect(googleAnchor.getAttribute("href")).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`,
    );
  });

  it("leads with each route's time and gives its distance, falling back to haversine", () => {
    const { unmount } = renderCard({
      ownRoute,
      otherParticipants: [
        {
          index: 1 as ParticipantIndex,
          route: otherRoute,
          position: otherPosition,
          stale: false,
          name: null,
        },
      ],
    });

    const [own, other] = rows();
    expect(
      within(own!).getByText(formatDistance(ownRoute.distance)),
    ).toBeTruthy();
    expect(
      within(other!).getByText(formatDistance(otherRoute.distance)),
    ).toBeTruthy();
    expect(
      within(own!).getByText('live.etaMinutes:{"minutes":40}'),
    ).toBeTruthy();
    expect(
      within(other!).getByText('live.etaMinutes:{"minutes":35}'),
    ).toBeTruthy();

    unmount();

    // Without routes — haversine fallback
    renderCard({ ownRoute: null });
    const haversineOwn = formatDistance(
      haversineDistance(ownPosition, destination),
    );
    expect(screen.getByText(haversineOwn)).toBeTruthy();
    expect(screen.queryByText(/live\.etaMinutes/)).toBeNull();
  });

  it("gives a trip of an hour or more in hours and minutes", () => {
    const { unmount } = renderCard({
      ownRoute: { ...ownRoute, duration: 4500 },
    });
    expect(
      screen.getByText('live.etaHours:{"hours":1,"minutes":15}'),
    ).toBeTruthy();
    unmount();

    // Not "1 h 0 min".
    renderCard({ ownRoute: { ...ownRoute, duration: 3600 } });
    expect(screen.getByText('live.etaHoursExact:{"hours":1}')).toBeTruthy();
  });

  // The midpoint is halfway in distance, rarely in time; the card says how
  // far apart the arrivals are rather than implying they match.
  it("says how far apart the arrivals are once two routes are in", () => {
    const { unmount } = renderCard({
      ownRoute,
      otherParticipants: [
        {
          index: 1 as ParticipantIndex,
          route: otherRoute,
          position: otherPosition,
          stale: false,
          name: null,
        },
      ],
    });
    expect(screen.getByText('live.spread:{"minutes":5}')).toBeTruthy();
    unmount();

    renderCard({
      ownRoute,
      otherParticipants: [
        {
          index: 1 as ParticipantIndex,
          route: { ...otherRoute, duration: ownRoute.duration - 30 },
          position: otherPosition,
          stale: false,
          name: null,
        },
      ],
    });
    expect(screen.getByText("live.spreadEven")).toBeTruthy();
  });

  it("claims no gap with fewer than two routes", () => {
    renderCard({ ownRoute });
    expect(screen.queryByText(/live\.spread/)).toBeNull();
  });

  // The graph knew the routes were left over from before a failed refresh,
  // and the card presented them as current.
  it("notes when the routes shown could not be refreshed", () => {
    const { unmount } = renderCard({ ownRoute });
    expect(screen.queryByText("live.routesStale")).toBeNull();
    unmount();

    renderCard({ ownRoute, routesStale: true });
    expect(screen.getByText("live.routesStale")).toBeTruthy();
  });

  // With a venue picked and no route yet, the card said "Meet at X" over
  // straight-line distances to the midpoint.
  it("measures the straight-line fallback to the destination, not the midpoint", () => {
    renderCard({ ownRoute: null, selectedVenueName: "Cafe One" });

    expect(
      screen.queryByText(
        formatDistance(haversineDistance(ownPosition, midpoint)),
      ),
    ).toBeNull();
    expect(
      screen.getByText(
        formatDistance(haversineDistance(ownPosition, destination)),
      ),
    ).toBeTruthy();
  });

  // Inside a Hebrew row, "40.6 km" was laid out by the bidi algorithm as
  // "km 40.6". Isolated, it keeps its own order in either direction.
  it("isolates each distance from the row's text direction", () => {
    renderCard({ ownRoute });
    const distance = screen.getByText(formatDistance(ownRoute.distance));
    expect(distance.tagName).toBe("BDI");
  });
});
