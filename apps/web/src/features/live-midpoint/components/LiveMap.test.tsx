import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../../lib/config", () => ({
  APP_CONFIG: { mapboxToken: "pk.test" },
}));

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));
vi.mock("@sentry/react", () => ({ captureException }));

/** What `new mapboxgl.Map(...)` does in each case: throw, or hand back a fake. */
const mapbox = vi.hoisted(() => ({
  construct: (): object => {
    throw new Error("construct not set");
  },
}));
vi.mock("mapbox-gl", () => {
  class Map {
    constructor() {
      return mapbox.construct();
    }
  }
  class NavigationControl {}
  class GeolocateControl {}
  return {
    default: { Map, NavigationControl, GeolocateControl, accessToken: "" },
  };
});

import LiveMap from "./LiveMap";
import { NO_INSETS } from "../lib/camera-insets";

function fakeMap() {
  const handlers = new Map<string, (event: unknown) => void>();
  return {
    handlers,
    map: {
      on: (event: string, handler: (event: unknown) => void) => {
        handlers.set(event, handler);
      },
      addControl: vi.fn(),
      remove: vi.fn(),
    },
  };
}

const PROPS = {
  participants: [],
  midpoint: null,
  routes: [],
  venues: [],
  selectedVenue: null,
  insets: NO_INSETS,
};

describe("LiveMap", () => {
  beforeEach(() => {
    captureException.mockClear();
  });

  // Without WebGL the constructor throws. From the effect, that reached the
  // error boundary, which replaced the whole page — the cards, the distances
  // and the share link with it — for want of a map.
  it("shows a notice in place of a map the device cannot draw", () => {
    const failure = new Error("Failed to initialize WebGL");
    mapbox.construct = () => {
      throw failure;
    };

    render(<LiveMap {...PROPS} />);

    expect(screen.getByRole("status").textContent).toBe("live.mapUnavailable");
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { phase: "map-init" },
    });
  });

  // A rejected token left a blank map and no report anywhere.
  it("reports the first map error, not every repeat", () => {
    const fake = fakeMap();
    mapbox.construct = () => fake.map;
    render(<LiveMap {...PROPS} />);

    const unauthorized = new Error("Unauthorized");
    fake.handlers.get("error")?.({ error: unauthorized });
    fake.handlers.get("error")?.({ error: new Error("tile failed") });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(unauthorized, {
      tags: { phase: "map" },
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
