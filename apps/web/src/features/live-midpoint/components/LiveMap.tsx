import mapboxgl from "mapbox-gl";
// Bundled, not linked from the CDN. index.html used to load it with an inline
// `onload` swap, which the production CSP (no 'unsafe-inline') refuses — so in
// production it never applied, the canvas lost `position: absolute`, and every
// marker was laid out below the map, off-screen. Bundling also pins it to the
// installed mapbox-gl rather than a hard-coded, older CDN version.
import "mapbox-gl/dist/mapbox-gl.css";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Sentry from "@sentry/react";
import type * as GeoJSON from "geojson";
import type { LatLng } from "../lib/geo-math";
import { accuracyCircleGeoJSON } from "../lib/geo-math";
import { fitSignature, hasSettled, sameMembers } from "../lib/fit-bounds";
import type { FitSignature } from "../lib/fit-bounds";
import type { Insets } from "../lib/camera-insets";
import { fitPadding, NO_INSETS, sameInsets } from "../lib/camera-insets";
import type { MapParticipant } from "../graph/types";
import {
  PARTICIPANT_COLORS,
  MAX_PARTICIPANTS,
} from "../lib/participant-config";
import type { RankedVenue } from "../lib/venue-ranking";
import { APP_CONFIG } from "../../../lib/config";
export type { MapParticipant };

import { FitControl } from "./fit-control";
import LiveParticipantMarker from "./LiveParticipantMarker";
import LiveMidpointMarker from "./LiveMidpointMarker";
import VenueMarker from "./VenueMarker";
import "../styles/live-midpoint.css";

const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683]; // Israel
const DEFAULT_ZOOM = 8;
const DARK_STYLE = "mapbox://styles/mapbox/dark-v11";
const FIT_MOVEMENT_THRESHOLD_M = 50; // Skip refit if all points moved < 50m
/** Room around the framed markers, inside what the overlays leave visible. */
const MARKER_MARGIN_PX = 40;
const FIT_MAX_ZOOM = 16;
const SINGLE_POINT_ZOOM = 14;
const FIT_DURATION_MS = 800;

/** Zoom buttons only where there is a mouse: on a touch screen they repeat a pinch. */
function hasFinePointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

function fitDuration(): number {
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? 0 : FIT_DURATION_MS;
}

// mapbox-gl exposes one global access token, not a per-instance one, so
// this cannot be injected. Sourcing it from the config module still keeps
// the environment read in a single place.
mapboxgl.accessToken = APP_CONFIG.mapboxToken;

// Hebrew labels need no setup: since 3.33 Mapbox shapes right-to-left text
// itself, fetching a small WebAssembly module from api.mapbox.com the first
// time such text is on screen. The CSP admits both halves of that —
// `connect-src https://*.mapbox.com` for the fetch, and `'unsafe-eval'` in
// `script-src` for compiling it.

interface LiveMapProps {
  participants: readonly MapParticipant[];
  midpoint: LatLng | null;
  routes: readonly (GeoJSON.LineString | null)[];
  venues: readonly RankedVenue[];
  selectedVenue: RankedVenue | null;
  /**
   * What the overlays cover of the full-bleed map (`useOverlayInsets`). Fits
   * frame inside the rest, so nothing they frame lands under the sheet.
   */
  insets: Insets;
}

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function lineFeature(geom: GeoJSON.LineString): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: geom, properties: {} }],
  };
}

function polygonFeature(geom: GeoJSON.Polygon): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: geom, properties: {} }],
  };
}

/** Below this zoom an accuracy circle is a pixel or two of smear. */
const ACCURACY_MIN_ZOOM = 12;
/** Just darker than the basemap, so a route reads as one stroke over its roads. */
const CASING_COLOR = "#05050a";

type LayerSpec = Parameters<mapboxgl.Map["addLayer"]>[0];

/**
 * The style's first label layer. Data goes beneath it: added on top of the
 * whole style, the routes struck through the names of the towns they crossed.
 * A style with no labels (the e2e suite's) takes data on top.
 */
function firstSymbolLayerId(map: mapboxgl.Map): string | undefined {
  return map.getStyle()?.layers?.find((layer) => layer.type === "symbol")?.id;
}

function addSourcesAndLayers(map: mapboxgl.Map): void {
  const beforeId = firstSymbolLayerId(map);
  // Guarded one by one, so a style.load re-entry adds only what is missing.
  const add = (layer: LayerSpec) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId);
  };

  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    if (!map.getSource(`accuracy-${i}`)) {
      map.addSource(`accuracy-${i}`, { type: "geojson", data: EMPTY_FC });
    }
    if (!map.getSource(`route-${i}`)) {
      map.addSource(`route-${i}`, { type: "geojson", data: EMPTY_FC });
    }
  }

  // In passes, each just beneath the labels and so above the one before:
  // every accuracy circle, then every route casing, then every route. Added
  // slot by slot instead, slot 1's casing cut a dark gap through slot 0's
  // route where the two converge on the destination.
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    const color = PARTICIPANT_COLORS[i].hex;
    add({
      id: `accuracy-${i}-fill`,
      type: "fill",
      source: `accuracy-${i}`,
      minzoom: ACCURACY_MIN_ZOOM,
      paint: { "fill-color": color, "fill-opacity": 0.12 },
    });
    add({
      id: `accuracy-${i}-outline`,
      type: "line",
      source: `accuracy-${i}`,
      minzoom: ACCURACY_MIN_ZOOM,
      paint: { "line-color": color, "line-width": 1, "line-opacity": 0.3 },
    });
  }
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    add({
      id: `route-${i}-casing`,
      type: "line",
      source: `route-${i}`,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": CASING_COLOR,
        "line-width": 8,
        "line-opacity": 0.9,
      },
    });
  }
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    add({
      id: `route-${i}-layer`,
      type: "line",
      source: `route-${i}`,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": PARTICIPANT_COLORS[i].hex,
        "line-width": 4.5,
        "line-opacity": 0.95,
      },
    });
  }
}

/**
 * Frame every point in `signature` inside what the overlays leave visible.
 *
 * The padding is the overlays' insets plus a margin, clamped by `fitPadding`
 * so it can never exceed the map: Mapbox drops a fit whose padding leaves no
 * room, which on a phone was every fit. Mapbox keeps the padding as the map's
 * own afterwards, so a later single-point `easeTo` centres in the same area.
 */
function frame(map: mapboxgl.Map, signature: FitSignature, insets: Insets) {
  const container = map.getContainer();
  const padding = fitPadding(
    insets,
    MARKER_MARGIN_PX,
    container.clientWidth,
    container.clientHeight,
  );
  const points = [...signature.values()];
  const first = points[0];
  if (first === undefined) return;

  if (points.length === 1) {
    map.easeTo({
      center: [first.lng, first.lat],
      zoom: SINGLE_POINT_ZOOM,
      padding,
      duration: fitDuration(),
    });
    return;
  }

  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  map.fitBounds(
    [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
    { padding, maxZoom: FIT_MAX_ZOOM, duration: fitDuration() },
  );
}

/**
 * memo() is load-bearing, not decoration. The page re-renders on every GPS fix
 * and every RTDB heartbeat; without it each render re-ran the effects below,
 * and `GeoJSONSource.setData` re-serialises a whole route geometry — thousands
 * of coordinate pairs, five sources — for data that had not changed. Paired
 * with the memoised props on the page, the effects now fire only when the
 * geometry genuinely differs.
 */
function LiveMap({
  participants,
  midpoint,
  routes,
  venues,
  selectedVenue,
  insets,
}: LiveMapProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const lastFitRef = useRef<FitSignature>(new Map<string, LatLng>());
  const lastInsetsRef = useRef<Insets>(NO_INSETS);

  // Whether the map frames everyone by itself. A gesture hands the camera to
  // the user — a refit every time someone moved 50m used to yank them back
  // from wherever they had panned — and Show everyone hands it back.
  const [following, setFollowing] = useState(true);
  const fitControlRef = useRef<FitControl | null>(null);

  // What Show everyone frames, read when it is tapped: the control outlives
  // every render, so it cannot close over one render's props.
  const framingRef = useRef({ participants, midpoint, selectedVenue, insets });
  framingRef.current = { participants, midpoint, selectedVenue, insets };
  const fitLabelRef = useRef(t("live.fitAll"));
  fitLabelRef.current = t("live.fitAll");

  // ── Map initialization ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const controlPos = "top-right" as const;

    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: DARK_STYLE,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        // North stays up. Rotation and pitch tell nobody where to meet, and
        // they were what the compass button existed to undo.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch (err) {
      // No WebGL: an old device, or a browser with it switched off. Mapbox
      // throws from the constructor, and from this effect the error reached
      // the boundary — "Something went wrong" over a session that works
      // without a map. Distances, navigation and the share link need none.
      Sentry.captureException(err, { tags: { phase: "map-init" } });
      setUnavailable(true);
      return;
    }

    // A rejected token or an unreachable style left a blank canvas and told
    // nobody. Once per map: tile errors repeat for as long as the network is
    // down, and the first says what the rest would.
    let reported = false;
    map.on("error", (event) => {
      if (reported) return;
      reported = true;
      Sentry.captureException(event.error, { tags: { phase: "map" } });
    });

    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    if (hasFinePointer()) {
      map.addControl(
        new mapboxgl.NavigationControl({ showCompass: false }),
        controlPos,
      );
    }
    const fitControl = new FitControl(fitLabelRef.current, () => {
      const framing = framingRef.current;
      const signature = fitSignature(
        framing.participants,
        framing.midpoint,
        framing.selectedVenue,
      );
      if (signature.size === 0) return;
      lastFitRef.current = signature;
      lastInsetsRef.current = framing.insets;
      frame(map, signature, framing.insets);
      setFollowing(true);
    });
    map.addControl(fitControl, controlPos);
    fitControlRef.current = fitControl;

    // A gesture carries the input event that began it; a camera move of our
    // own carries none. mapbox-gl's window-resize handler passes its `resize`
    // event the same way, and turning the phone is not taking the camera.
    map.on("movestart", (event: { originalEvent?: Event }) => {
      const input = event.originalEvent;
      if (input !== undefined && input.type !== "resize") setFollowing(false);
    });

    let loaded = false;
    map.on("load", () => {
      addSourcesAndLayers(map);
      loaded = true;
      setMapInstance(map);
    });
    map.on("style.load", () => {
      if (loaded) addSourcesAndLayers(map);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      fitControlRef.current = null;
      setMapInstance(null);
    };
  }, []);

  useEffect(() => {
    fitControlRef.current?.setAttention(!following);
  }, [following]);

  // ── Update route polylines ──
  useEffect(() => {
    if (!mapInstance) return;
    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const src = mapInstance.getSource(`route-${i}`) as
        mapboxgl.GeoJSONSource | undefined;
      if (!src) continue;
      const routeGeom = routes[i] ?? null;
      src.setData(routeGeom ? lineFeature(routeGeom) : EMPTY_FC);
    }
  }, [mapInstance, routes]);

  // ── Update accuracy circles ──
  useEffect(() => {
    if (!mapInstance) return;

    // Build a map of index → participant for quick lookup
    const byIndex = new Map<number, MapParticipant>();
    for (const p of participants) {
      byIndex.set(p.index, p);
    }

    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const src = mapInstance.getSource(`accuracy-${i}`) as
        mapboxgl.GeoJSONSource | undefined;
      if (!src) continue;
      const p = byIndex.get(i);
      src.setData(
        p && p.accuracy
          ? polygonFeature(accuracyCircleGeoJSON(p.position, p.accuracy))
          : EMPTY_FC,
      );
    }
  }, [mapInstance, participants]);

  // ── Fit bounds to all points (with jitter suppression) ──
  // A change in what the overlays cover refits too: the sheet growing a line
  // would otherwise slide over markers framed for the shorter one.
  useEffect(() => {
    if (!mapInstance) return;

    // Keyed by identity, not by array position — see lib/fit-bounds.ts.
    const current = fitSignature(participants, midpoint, selectedVenue);
    if (current.size === 0) return;
    // Someone joined or left, or a venue was picked or cleared: news worth
    // taking the camera back for. Movement alone never takes it from a user
    // who is holding it.
    const membersChanged = !sameMembers(lastFitRef.current, current);
    if (!membersChanged) {
      if (!following) return;
      if (
        sameInsets(lastInsetsRef.current, insets) &&
        hasSettled(lastFitRef.current, current, FIT_MOVEMENT_THRESHOLD_M)
      ) {
        return;
      }
    }
    lastFitRef.current = current;
    lastInsetsRef.current = insets;
    frame(mapInstance, current, insets);
    if (!following) setFollowing(true);
  }, [mapInstance, participants, midpoint, selectedVenue, insets, following]);

  return (
    <>
      <div
        ref={containerRef}
        className="live-map-container"
        role="application"
        aria-label={t("live.mapLabel")}
      >
        {unavailable && (
          <div className="live-map-unavailable" role="status">
            {t("live.mapUnavailable")}
          </div>
        )}
      </div>
      {mapInstance &&
        participants.map((p) => (
          <LiveParticipantMarker
            key={p.index}
            map={mapInstance}
            lat={p.position.lat}
            lng={p.position.lng}
            participantIndex={p.index}
            stale={p.stale}
          />
        ))}
      {mapInstance && midpoint && (
        <LiveMidpointMarker
          map={mapInstance}
          lat={midpoint.lat}
          lng={midpoint.lng}
        />
      )}
      {mapInstance &&
        venues.map((v) => (
          <VenueMarker
            key={v.id}
            map={mapInstance}
            lat={v.location.lat}
            lng={v.location.lng}
            name={v.displayName}
            selected={selectedVenue?.id === v.id}
          />
        ))}
    </>
  );
}

export default memo(LiveMap);
