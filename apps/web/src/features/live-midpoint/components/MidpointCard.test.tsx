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

import MidpointCard from "./MidpointCard";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import type { RouteInfo } from "../hooks/useDirections";
import type { ParticipantIndex } from "../lib/participant-config";

const ownPosition: LatLng = { lat: 32.08, lng: 34.78 };
const otherPosition: LatLng = { lat: 31.77, lng: 35.21 };
const midpoint: LatLng = { lat: 31.95, lng: 34.85 };
const destination: LatLng = { lat: 31.93, lng: 35.0 };

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
}

function renderCard(
  overrides: Partial<Parameters<typeof MidpointCard>[0]> = {},
) {
  const defaults = {
    midpoint,
    ownIndex: 0 as ParticipantIndex,
    ownPosition,
    ownRoute: null as RouteInfo | null,
    otherParticipants: [
      { index: 1 as ParticipantIndex, route: null, position: otherPosition, stale: false },
    ] as OtherParticipant[],
    destination,
    travelProfile: "driving" as const,
    onProfileChange: vi.fn(),
    selectedVenueName: null as string | null,
  };
  return render(<MidpointCard {...defaults} {...overrides} />);
}

describe("MidpointCard", () => {
  it("renders distance stats for own and other participants", () => {
    renderCard();

    expect(screen.getByText("live.yourDistance")).toBeTruthy();
    expect(
      screen.getByText('live.participantDistance:{"n":2}'),
    ).toBeTruthy();

    const expectedOwn = formatDistance(haversineDistance(ownPosition, midpoint));
    const expectedOther = formatDistance(
      haversineDistance(otherPosition, midpoint),
    );
    expect(screen.getByText(expectedOwn)).toBeTruthy();
    expect(screen.getByText(expectedOther)).toBeTruthy();
  });

  it("shows stale warning when a participant is stale", () => {
    renderCard({
      otherParticipants: [
        { index: 1 as ParticipantIndex, route: null, position: otherPosition, stale: true },
      ],
    });

    expect(
      screen.getByText('live.participantStale:{"n":2}'),
    ).toBeTruthy();
    expect(screen.getByText("live.participantStaleHint")).toBeTruthy();
  });

  it("hides stale warning when no participants are stale", () => {
    renderCard({
      otherParticipants: [
        { index: 1 as ParticipantIndex, route: null, position: otherPosition, stale: false },
      ],
    });

    expect(screen.queryByText(/live\.participantStale/)).toBeNull();
  });

  it("shows venue name when selectedVenueName is provided", () => {
    renderCard({ selectedVenueName: "Cafe Roma" });

    expect(
      screen.getByText('live.meetAt:{"name":"Cafe Roma"}'),
    ).toBeTruthy();
  });

  it("driving/walking toggle calls onProfileChange", () => {
    const onProfileChange = vi.fn();
    renderCard({ onProfileChange, travelProfile: "driving" });

    fireEvent.click(screen.getByText("live.walking"));
    expect(onProfileChange).toHaveBeenCalledWith("walking");

    fireEvent.click(screen.getByText("live.driving"));
    expect(onProfileChange).toHaveBeenCalledWith("driving");
  });

  it("nav links contain correct Waze and Google Maps URLs", () => {
    renderCard();

    const wazeAnchor = screen.getByText("live.navigateWaze").closest("a");
    const googleAnchor = screen
      .getByText("live.navigateGoogle")
      .closest("a");

    expect(wazeAnchor!.getAttribute("href")).toBe(
      `https://waze.com/ul?ll=${destination.lat},${destination.lng}&navigate=yes`,
    );
    expect(googleAnchor!.getAttribute("href")).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}`,
    );
  });

  it("shows route distance when routes available, falls back to haversine", () => {
    const { unmount } = renderCard({
      ownRoute,
      otherParticipants: [
        { index: 1 as ParticipantIndex, route: otherRoute, position: otherPosition, stale: false },
      ],
    });

    expect(screen.getByText(formatDistance(ownRoute.distance))).toBeTruthy();
    expect(
      screen.getByText(formatDistance(otherRoute.distance)),
    ).toBeTruthy();
    expect(
      screen.getByText('live.driveTime:{"minutes":"40"}'),
    ).toBeTruthy();
    expect(
      screen.getByText('live.driveTime:{"minutes":"35"}'),
    ).toBeTruthy();

    unmount();

    // Without routes — haversine fallback
    renderCard({ ownRoute: null });
    const haversineOwn = formatDistance(
      haversineDistance(ownPosition, midpoint),
    );
    expect(screen.getByText(haversineOwn)).toBeTruthy();
    expect(screen.queryByText(/live\.driveTime/)).toBeNull();
  });
});
