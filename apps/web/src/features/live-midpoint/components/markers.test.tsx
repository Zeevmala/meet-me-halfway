import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Map as MapboxMap } from "mapbox-gl";
import LiveParticipantMarker from "./LiveParticipantMarker";
import LiveMidpointMarker from "./LiveMidpointMarker";
import VenueMarker from "./VenueMarker";

/**
 * jsdom has no layout, so where a marker lands on screen is the e2e suite's
 * to check (e2e/live-session.spec.ts). What can be pinned here is the
 * structure that makes the layout right: Mapbox is handed a bare root it can
 * position, and every class we style lives on a child it never touches.
 */

const handedToMapbox: HTMLElement[] = [];

vi.mock("mapbox-gl", () => {
  class Marker {
    private readonly element: HTMLElement;
    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
      // What the real constructor does to the element it is given.
      this.element.classList.add(
        "mapboxgl-marker",
        "mapboxgl-marker-anchor-center",
      );
      handedToMapbox.push(this.element);
    }
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      return this;
    }
  }
  return { default: { Marker } };
});

const map = {} as MapboxMap;

function onlyRoot(): HTMLElement {
  expect(handedToMapbox).toHaveLength(1);
  return handedToMapbox[0] as HTMLElement;
}

beforeEach(() => {
  handedToMapbox.length = 0;
});

describe("marker elements", () => {
  it("styles a child of the participant marker's root, never the root", () => {
    render(
      <LiveParticipantMarker
        map={map}
        lat={32}
        lng={34}
        participantIndex={1}
      />,
    );

    const root = onlyRoot();
    expect(root.className).toBe(
      "mapboxgl-marker mapboxgl-marker-anchor-center",
    );
    expect(root.firstElementChild?.classList).toContain("live-marker--p1");
  });

  it("dims a stale participant on the child, out of reach of Mapbox's inline opacity", () => {
    const { rerender } = render(
      <LiveParticipantMarker
        map={map}
        lat={32}
        lng={34}
        participantIndex={2}
      />,
    );
    rerender(
      <LiveParticipantMarker
        map={map}
        lat={32}
        lng={34}
        participantIndex={2}
        stale
      />,
    );

    const root = onlyRoot();
    expect(root.classList).not.toContain("live-marker--stale");
    expect(root.firstElementChild?.classList).toContain("live-marker--stale");
  });

  it("styles a child of the midpoint marker's root", () => {
    render(<LiveMidpointMarker map={map} lat={32} lng={34} />);

    const root = onlyRoot();
    expect(root.classList).not.toContain("live-marker--mid");
    expect(root.firstElementChild?.classList).toContain("live-marker--mid");
  });

  // Colour alone told people apart, and it fails anyone who cannot tell the
  // green from the orange.
  it("letters each participant by the badge pill's rule, and follows a rename", () => {
    const props = { map, lat: 32, lng: 34, participantIndex: 2 as const };
    const { rerender } = render(<LiveParticipantMarker {...props} label="A" />);
    const dot = onlyRoot().firstElementChild;
    expect(dot?.textContent).toBe("A");

    rerender(<LiveParticipantMarker {...props} label="D" />);
    expect(onlyRoot().firstElementChild?.textContent).toBe("D");
    expect(handedToMapbox).toHaveLength(1);
  });

  it("marks your own dot as yours instead of lettering it", () => {
    render(
      <LiveParticipantMarker
        map={map}
        lat={32}
        lng={34}
        participantIndex={0}
        label={null}
        isOwn
      />,
    );
    const dot = onlyRoot().firstElementChild;
    expect(dot?.classList).toContain("live-marker--own");
    expect(dot?.classList).toContain("live-marker--p0");
    expect(dot?.textContent).toBe("");
  });

  // It was a pulsing dot like a participant's, in participant 5's pink.
  it("draws the meeting point still: no pulse ring, which means someone live", () => {
    render(<LiveMidpointMarker map={map} lat={32} lng={34} />);
    const dot = onlyRoot().firstElementChild;
    expect(dot?.querySelector(".live-marker-ring")).toBeNull();
  });

  it("mutes the midpoint while a venue is the destination, on the child", () => {
    const { rerender } = render(
      <LiveMidpointMarker map={map} lat={32} lng={34} muted={false} />,
    );
    const root = onlyRoot();
    const dot = root.firstElementChild;
    expect(dot?.classList).not.toContain("live-marker--mid-muted");

    rerender(<LiveMidpointMarker map={map} lat={32} lng={34} muted />);
    expect(dot?.classList).toContain("live-marker--mid-muted");
    expect(dot?.classList).toContain("live-marker--mid");
    expect(root.classList).toContain("mapboxgl-marker");

    rerender(<LiveMidpointMarker map={map} lat={32} lng={34} muted={false} />);
    expect(dot?.classList).not.toContain("live-marker--mid-muted");
  });

  it("keeps Mapbox's classes when a venue is selected and deselected", () => {
    // Selection used to assign `className` on the element Mapbox positions,
    // which removed `mapboxgl-marker` and its absolute positioning with it.
    const props = { map, lat: 32, lng: 34, name: "Cafe" };
    const { rerender } = render(<VenueMarker {...props} selected={false} />);
    const root = onlyRoot();
    const dot = root.firstElementChild;

    expect(dot?.classList).toContain("live-marker--venue");

    rerender(<VenueMarker {...props} selected />);
    expect(root.classList).toContain("mapboxgl-marker");
    expect(dot?.classList).toContain("live-marker--venue-selected");
    expect(dot?.classList).not.toContain("live-marker--venue");

    rerender(<VenueMarker {...props} selected={false} />);
    expect(root.classList).toContain("mapboxgl-marker");
    expect(dot?.classList).toContain("live-marker--venue");
    expect(dot?.classList).not.toContain("live-marker--venue-selected");
  });
});
