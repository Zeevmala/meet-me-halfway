import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

// Mock CSS import
vi.mock("../styles/live-midpoint.css", () => ({}));

import VenueListCard from "./VenueListCard";
import type { RankedVenue } from "../lib/venue-ranking";
import { formatDistance } from "../lib/geo-math";

function makeVenue(overrides: Partial<RankedVenue> = {}): RankedVenue {
  return {
    id: "v1",
    displayName: "Cafe Central",
    location: { lat: 31.93, lng: 35.0 },
    rating: 4.5,
    userRatingCount: 120,
    openNow: true,
    types: ["cafe"],
    distanceFromMidpoint: 350,
    score: 0.85,
    ...overrides,
  };
}

const venues: RankedVenue[] = [
  makeVenue({
    id: "v1",
    displayName: "Cafe Central",
    rating: 4.5,
    openNow: true,
    distanceFromMidpoint: 350,
  }),
  makeVenue({
    id: "v2",
    displayName: "Pizza Place",
    rating: 3.8,
    openNow: false,
    distanceFromMidpoint: 800,
  }),
  makeVenue({
    id: "v3",
    displayName: "Sushi Bar",
    rating: 4.9,
    openNow: true,
    distanceFromMidpoint: 150,
  }),
];

function renderCard(
  overrides: Partial<Parameters<typeof VenueListCard>[0]> = {},
) {
  const defaults = {
    venues,
    status: "ready" as const,
    selectedVenue: null as RankedVenue | null,
    onSelectVenue: vi.fn(),
  };
  return render(<VenueListCard {...defaults} {...overrides} />);
}

describe("VenueListCard", () => {
  it("shows the searching shimmer while nothing has come back yet", () => {
    const { container } = renderCard({ venues: [], status: "searching" });

    expect(screen.getByText("live.searchingVenues")).toBeTruthy();
    const skeletons = container.querySelectorAll(".live-venue-skeleton");
    expect(skeletons.length).toBe(3);
  });

  it("says there are no venues only when an answer said so", () => {
    renderCard({ venues: [], status: "ready" });

    expect(screen.getByText("live.nearbyVenues")).toBeTruthy();
    expect(screen.getByText("live.noVenues")).toBeTruthy();
  });

  // It said "No venues found" when the search had failed — the conflation
  // places-api.ts was rewritten to undo, come back at the last step.
  it("says the search failed, not that there is nothing nearby", () => {
    renderCard({ venues: [], status: "failed" });

    expect(screen.getByRole("status").textContent).toBe("live.venuesFailed");
    expect(screen.queryByText("live.noVenues")).toBeNull();
  });

  // The skeleton used to replace the list for every refresh, and hide Clear
  // with it.
  it("keeps the list, and Clear, while a newer search is out", () => {
    renderCard({ status: "searching", selectedVenue: venues[0] ?? null });

    expect(screen.getByText("Cafe Central")).toBeTruthy();
    expect(screen.getByText("live.clearVenue")).toBeTruthy();
    expect(screen.queryByText("live.searchingVenues")).toBeNull();
  });

  it("renders nothing while no search is wanted", () => {
    const { container } = renderCard({ venues: [], status: "idle" });

    expect(container.firstChild).toBeNull();
  });

  it("renders venue list with names, ratings, distances", () => {
    renderCard();

    expect(screen.getByText("Cafe Central")).toBeTruthy();
    expect(screen.getByText("Pizza Place")).toBeTruthy();
    expect(screen.getByText("Sushi Bar")).toBeTruthy();

    // Ratings displayed
    expect(screen.getByText("\u2605 4.5")).toBeTruthy();
    expect(screen.getByText("\u2605 3.8")).toBeTruthy();
    expect(screen.getByText("\u2605 4.9")).toBeTruthy();

    // Distances displayed via formatDistance
    expect(screen.getByText(formatDistance(350))).toBeTruthy();
    expect(screen.getByText(formatDistance(800))).toBeTruthy();
    expect(screen.getByText(formatDistance(150))).toBeTruthy();
  });

  it("shows open now badge for open venues", () => {
    renderCard();

    const openBadges = screen.getAllByText("live.openNow");
    // v1 and v3 are open, v2 is not
    expect(openBadges.length).toBe(2);
  });

  it("selecting a venue calls onSelectVenue", () => {
    const onSelectVenue = vi.fn();
    renderCard({ onSelectVenue });

    fireEvent.click(screen.getByText("Pizza Place"));
    expect(onSelectVenue).toHaveBeenCalledWith(venues[1]);
  });

  it("deselecting (clicking selected) calls onSelectVenue(null)", () => {
    const onSelectVenue = vi.fn();
    renderCard({ onSelectVenue, selectedVenue: venues[0] });

    fireEvent.click(screen.getByText("Cafe Central"));
    expect(onSelectVenue).toHaveBeenCalledWith(null);
  });

  it("clear button appears when a venue is selected and calls onSelectVenue(null)", () => {
    const onSelectVenue = vi.fn();
    renderCard({ onSelectVenue, selectedVenue: venues[2] });

    const clearBtn = screen.getByText("live.clearVenue");
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn);
    expect(onSelectVenue).toHaveBeenCalledWith(null);
  });

  it("venue items have correct aria-selected attribute", () => {
    renderCard({ selectedVenue: venues[1] });

    const options = screen.getAllByRole("option");
    expect(options.length).toBe(3);

    // v1 not selected
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    // v2 selected
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    // v3 not selected
    expect(options[2].getAttribute("aria-selected")).toBe("false");
  });
});
