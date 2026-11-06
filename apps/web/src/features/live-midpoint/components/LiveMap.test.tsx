import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

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
  options: [] as Record<string, unknown>[],
}));
vi.mock("mapbox-gl", () => {
  class Map {
    constructor(options: Record<string, unknown>) {
      mapbox.options.push(options);
      return mapbox.construct();
    }
  }
  class NavigationControl {
    constructor(readonly options?: Record<string, unknown>) {}
  }
  class GeolocateControl {}
  class Marker {
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
  return {
    default: {
      Map,
      NavigationControl,
      GeolocateControl,
      Marker,
      accessToken: "",
    },
  };
});

import mapboxgl from "mapbox-gl";
import LiveMap from "./LiveMap";
import { FitControl } from "./fit-control";
import { NO_INSETS, fitPadding } from "../lib/camera-insets";
import type { Insets } from "../lib/camera-insets";
import type { MapParticipant } from "../graph/types";
import type { LatLng } from "../lib/geo-math";

interface Control {
  onAdd?: (map: unknown) => HTMLElement;
}

/**
 * A stand-in for the map, holding what LiveMap asks of a real one. Controls
 * get `onAdd` as Mapbox calls it, so Show everyone has a button to press.
 */
function fakeMap(
  width = 390,
  height = 700,
  styleLayers: { id: string; type: string }[] = [],
) {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const controls: unknown[] = [];
  const added: { id: string; minzoom?: number; beforeId?: string }[] = [];
  const map = {
    on: (event: string, handler: (event: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    addControl: vi.fn((control: Control) => {
      controls.push(control);
      control.onAdd?.(map);
    }),
    remove: vi.fn(),
    touchZoomRotate: { disableRotation: vi.fn() },
    keyboard: { disableRotation: vi.fn() },
    getStyle: () => ({ layers: styleLayers }),
    getSource: () => undefined,
    getLayer: (id: string) => added.find((layer) => layer.id === id),
    addSource: vi.fn(),
    addLayer: vi.fn(
      (layer: { id: string; minzoom?: number }, beforeId?: string) => {
        added.push({ ...layer, beforeId });
      },
    ),
    fitBounds: vi.fn(),
    easeTo: vi.fn(),
    getContainer: () => ({ clientWidth: width, clientHeight: height }),
  };
  const fire = (event: string, payload: unknown = {}) => {
    act(() => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    });
  };
  return { map, controls, added, fire };
}

function participant(
  index: 0 | 1 | 2,
  position: LatLng,
  isOwn = false,
): MapParticipant {
  return {
    index,
    position,
    accuracy: 0,
    isOwn,
    stale: false,
    label: isOwn ? null : String(index + 1),
  };
}

const TEL_AVIV = { lat: 32.0853, lng: 34.7818 };
const HAIFA = { lat: 32.794, lng: 34.9896 };
const MIDPOINT = { lat: 32.44, lng: 34.886 };

const PROPS = {
  participants: [] as MapParticipant[],
  midpoint: null as LatLng | null,
  routes: [],
  venues: [],
  selectedVenue: null,
  insets: NO_INSETS as Insets,
};

const TWO = {
  ...PROPS,
  participants: [
    participant(0, TEL_AVIV, true),
    participant(1, HAIFA),
  ] as MapParticipant[],
  midpoint: MIDPOINT as LatLng | null,
};

function fitButton(controls: unknown[]): HTMLButtonElement {
  const control = controls.find((c) => c instanceof FitControl);
  expect(control).toBeDefined();
  const button = (control as unknown as { button: HTMLButtonElement | null })
    .button;
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

describe("LiveMap", () => {
  beforeEach(() => {
    captureException.mockClear();
    mapbox.options.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    fake.fire("error", { error: unauthorized });
    fake.fire("error", { error: new Error("tile failed") });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(unauthorized, {
      tags: { phase: "map" },
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  describe("controls", () => {
    // The compass only ever undid a rotation; GeolocateControl ran a second
    // geolocation and drew Mapbox's blue dot beside participant 2's.
    it("keeps north up and offers Show everyone, not the compass or geolocate", () => {
      const fake = fakeMap();
      mapbox.construct = () => fake.map;
      render(<LiveMap {...PROPS} />);

      expect(mapbox.options[0]).toMatchObject({
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
      expect(fake.map.touchZoomRotate.disableRotation).toHaveBeenCalled();
      expect(fake.map.keyboard.disableRotation).toHaveBeenCalled();
      expect(
        fake.controls.some((c) => c instanceof mapboxgl.GeolocateControl),
      ).toBe(false);
      expect(fitButton(fake.controls).getAttribute("aria-label")).toBe(
        "live.fitAll",
      );
    });

    // A touch screen pinches; the buttons only repeated that.
    it("adds zoom buttons only where there is a fine pointer", () => {
      const touch = fakeMap();
      mapbox.construct = () => touch.map;
      const { unmount } = render(<LiveMap {...PROPS} />);
      expect(
        touch.controls.some((c) => c instanceof mapboxgl.NavigationControl),
      ).toBe(false);
      unmount();

      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          ({ matches: query.includes("pointer: fine") }) as MediaQueryList,
      );
      const mouse = fakeMap();
      mapbox.construct = () => mouse.map;
      render(<LiveMap {...PROPS} />);
      const zoom = mouse.controls.find(
        (c) => c instanceof mapboxgl.NavigationControl,
      ) as { options?: Record<string, unknown> } | undefined;
      expect(zoom?.options).toEqual({ showCompass: false });
    });
  });

  describe("layers", () => {
    const DARK_STYLE_LAYERS = [
      { id: "land", type: "background" },
      { id: "road-primary", type: "line" },
      { id: "road-label", type: "symbol" },
      { id: "settlement-label", type: "symbol" },
    ];

    // Added on top of the whole style, routes struck through the names of
    // the towns they crossed.
    it("draws routes and accuracy beneath the basemap's labels", () => {
      const fake = fakeMap(390, 700, DARK_STYLE_LAYERS);
      mapbox.construct = () => fake.map;
      render(<LiveMap {...PROPS} />);
      fake.fire("load");

      expect(fake.added.length).toBe(20);
      for (const layer of fake.added) {
        expect(layer.beforeId).toBe("road-label");
      }
    });

    // Slot by slot, a later casing cut a dark gap through an earlier route
    // where the two converge on the destination.
    it("adds every casing before any route, and accuracy before both", () => {
      const fake = fakeMap(390, 700, DARK_STYLE_LAYERS);
      mapbox.construct = () => fake.map;
      render(<LiveMap {...PROPS} />);
      fake.fire("load");

      const ids = fake.added.map((layer) => layer.id);
      const lastAccuracy = Math.max(
        ...ids.flatMap((id, i) => (id.startsWith("accuracy-") ? [i] : [])),
      );
      const casings = ids.flatMap((id, i) =>
        id.endsWith("-casing") ? [i] : [],
      );
      const routes = ids.flatMap((id, i) => (id.endsWith("-layer") ? [i] : []));
      expect(casings).toHaveLength(5);
      expect(routes).toHaveLength(5);
      expect(lastAccuracy).toBeLessThan(Math.min(...casings));
      expect(Math.max(...casings)).toBeLessThan(Math.min(...routes));
    });

    it("hides accuracy circles at regional zoom, where they are a smear", () => {
      const fake = fakeMap();
      mapbox.construct = () => fake.map;
      render(<LiveMap {...PROPS} />);
      fake.fire("load");

      const accuracy = fake.added.filter((l) => l.id.startsWith("accuracy-"));
      expect(accuracy).toHaveLength(10);
      for (const layer of accuracy) expect(layer.minzoom).toBe(12);
    });

    // The e2e suite's mock style has no layers at all.
    it("puts data on top of a style with no labels", () => {
      const fake = fakeMap();
      mapbox.construct = () => fake.map;
      render(<LiveMap {...PROPS} />);
      fake.fire("load");
      for (const layer of fake.added) expect(layer.beforeId).toBeUndefined();
    });

    it("adds nothing twice when the style loads again", () => {
      const fake = fakeMap(390, 700, DARK_STYLE_LAYERS);
      mapbox.construct = () => fake.map;
      render(<LiveMap {...PROPS} />);
      fake.fire("load");
      fake.fire("style.load");
      expect(fake.added.length).toBe(20);
    });
  });

  describe("camera", () => {
    function loaded(props = TWO, size = { width: 390, height: 700 }) {
      const fake = fakeMap(size.width, size.height);
      mapbox.construct = () => fake.map;
      const view = render(<LiveMap {...props} />);
      fake.fire("load");
      return { ...fake, ...view };
    }

    const moved = (by: number) => ({
      ...TWO,
      participants: [
        participant(0, { lat: TEL_AVIV.lat + by, lng: TEL_AVIV.lng }, true),
        participant(1, HAIFA),
      ],
    });

    // The production failure: padding sized for an older layout exceeded a
    // phone's map, and Mapbox dropped every fit.
    it("pads fits by the overlays, clamped to what the map can frame", () => {
      const insets = { top: 64, right: 0, bottom: 520, left: 0 };
      const { map } = loaded({ ...TWO, insets });

      expect(map.fitBounds).toHaveBeenCalledTimes(1);
      const options = map.fitBounds.mock.calls[0]?.[1] as {
        padding: Insets;
      };
      expect(options.padding).toEqual(fitPadding(insets, 40, 390, 700));
      expect(
        700 - options.padding.top - options.padding.bottom,
      ).toBeGreaterThanOrEqual(210);
    });

    it("refits when the overlays change what they cover", () => {
      const { map, rerender } = loaded();
      rerender(
        <LiveMap
          {...TWO}
          insets={{ top: 64, right: 0, bottom: 240, left: 0 }}
        />,
      );
      expect(map.fitBounds).toHaveBeenCalledTimes(2);
    });

    // A refit every time someone moved 50m yanked a user back from wherever
    // they had panned.
    it("stops refitting for movement once the user takes the camera", () => {
      const { map, fire, controls, rerender } = loaded();
      expect(map.fitBounds).toHaveBeenCalledTimes(1);

      fire("movestart", { originalEvent: { type: "touchstart" } });
      rerender(<LiveMap {...moved(0.05)} />);

      expect(map.fitBounds).toHaveBeenCalledTimes(1);
      expect(fitButton(controls).classList).toContain(
        "live-fit-btn--attention",
      );
    });

    it("hands the camera back when Show everyone is pressed", () => {
      const { map, fire, controls, rerender } = loaded();
      fire("movestart", { originalEvent: { type: "mousedown" } });
      rerender(<LiveMap {...moved(0.05)} />);

      act(() => fitButton(controls).click());
      expect(map.fitBounds).toHaveBeenCalledTimes(2);
      expect(fitButton(controls).classList).not.toContain(
        "live-fit-btn--attention",
      );

      // Following again: the next real move refits by itself.
      rerender(<LiveMap {...moved(0.1)} />);
      expect(map.fitBounds).toHaveBeenCalledTimes(3);
    });

    it("refits for a newcomer even while the user holds the camera", () => {
      const { map, fire, rerender } = loaded();
      fire("movestart", { originalEvent: { type: "wheel" } });

      rerender(
        <LiveMap
          {...TWO}
          participants={[
            ...TWO.participants,
            participant(2, { lat: 31.77, lng: 35.21 }),
          ]}
        />,
      );
      expect(map.fitBounds).toHaveBeenCalledTimes(2);
    });

    // mapbox-gl's window-resize handler fires movestart with the resize
    // event as its originalEvent. Turning the phone is not a gesture.
    it("keeps following through a window resize", () => {
      const { map, fire, rerender } = loaded();
      fire("movestart", { originalEvent: { type: "resize" } });
      rerender(<LiveMap {...moved(0.05)} />);
      expect(map.fitBounds).toHaveBeenCalledTimes(2);
    });

    // Our own camera moves carry no input event.
    it("keeps following through its own camera moves", () => {
      const { map, fire, rerender } = loaded();
      fire("movestart", {});
      rerender(<LiveMap {...moved(0.05)} />);
      expect(map.fitBounds).toHaveBeenCalledTimes(2);
    });

    it("does not animate the camera for a user who asked for less motion", () => {
      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          ({ matches: query.includes("reduced-motion") }) as MediaQueryList,
      );
      const { map } = loaded();
      expect(map.fitBounds.mock.calls[0]?.[1]).toMatchObject({ duration: 0 });
    });
  });
});
