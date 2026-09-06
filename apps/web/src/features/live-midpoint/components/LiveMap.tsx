import mapboxgl from "mapbox-gl";
import { memo, useEffect, useRef, useState } from "react";
import type * as GeoJSON from "geojson";
import type { LatLng } from "../lib/geo-math";
import { accuracyCircleGeoJSON } from "../lib/geo-math";
import { fitSignature, hasSettled } from "../lib/fit-bounds";
import type { MapParticipant } from "../graph/types";
import {
  PARTICIPANT_COLORS,
  MAX_PARTICIPANTS,
} from "../lib/participant-config";
import type { RankedVenue } from "../lib/venue-ranking";
import { APP_CONFIG } from "../../../lib/config";
export type { MapParticipant };

import LiveParticipantMarker from "./LiveParticipantMarker";
import LiveMidpointMarker from "./LiveMidpointMarker";
import VenueMarker from "./VenueMarker";
import "../styles/live-midpoint.css";

const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683]; // Israel
const DEFAULT_ZOOM = 8;
const DARK_STYLE = "mapbox://styles/mapbox/dark-v11";
const FIT_MOVEMENT_THRESHOLD_M = 50; // Skip refit if all points moved < 50m

// mapbox-gl exposes one global access token, not a per-instance one, so
// this cannot be injected. Sourcing it from the config module still keeps
// the environment read in a single place.
mapboxgl.accessToken = APP_CONFIG.mapboxToken;

// RTL text plugin for Hebrew map labels
try {
  mapboxgl.setRTLTextPlugin(
    "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js",
  );
} catch {
  /* already loaded */
}

interface LiveMapProps {
  participants: readonly MapParticipant[];
  midpoint: LatLng | null;
  routes: readonly (GeoJSON.LineString | null)[];
  venues: readonly RankedVenue[];
  selectedVenue: RankedVenue | null;
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

function addSourcesAndLayers(map: mapboxgl.Map): void {
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    if (map.getSource(`accuracy-${i}`)) continue; // already added (style.load re-entry)
    const color = PARTICIPANT_COLORS[i].hex;

    // Accuracy circle
    map.addSource(`accuracy-${i}`, { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: `accuracy-${i}-fill`,
      type: "fill",
      source: `accuracy-${i}`,
      paint: { "fill-color": color, "fill-opacity": 0.12 },
    });
    map.addLayer({
      id: `accuracy-${i}-outline`,
      type: "line",
      source: `accuracy-${i}`,
      paint: { "line-color": color, "line-width": 1, "line-opacity": 0.3 },
    });

    // Route line
    map.addSource(`route-${i}`, { type: "geojson", data: EMPTY_FC });
    map.addLayer({
      id: `route-${i}-layer`,
      type: "line",
      source: `route-${i}`,
      paint: {
        "line-color": color,
        "line-width": 4,
        "line-opacity": 0.8,
      },
    });
  }
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
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const lastFitRef = useRef<Map<string, LatLng>>(new Map());

  // ── Map initialization ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const controlPos = "top-right" as const;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: DARK_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), controlPos);
    map.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
      }),
      controlPos,
    );

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
      setMapInstance(null);
    };
  }, []);

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
  useEffect(() => {
    if (!mapInstance) return;

    // Keyed by identity, not by array position — see lib/fit-bounds.ts.
    const current = fitSignature(participants, midpoint, selectedVenue);
    if (current.size === 0) return;
    if (hasSettled(lastFitRef.current, current, FIT_MOVEMENT_THRESHOLD_M)) {
      return;
    }
    lastFitRef.current = current;

    const points = [...current.values()];
    const first = points[0];
    if (points.length === 1 && first !== undefined) {
      mapInstance.easeTo({
        center: [first.lng, first.lat],
        zoom: 14,
        duration: 800,
      });
      return;
    }

    const lngs = points.map((p) => p.lng);
    const lats = points.map((p) => p.lat);

    mapInstance.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      {
        padding: { top: 80, left: 40, right: 40, bottom: 350 },
        maxZoom: 16,
        duration: 800,
      },
    );
  }, [mapInstance, participants, midpoint, selectedVenue]);

  return (
    <>
      <div
        ref={containerRef}
        className="live-map-container"
        role="application"
        aria-label="Interactive live map showing participant locations and midpoint"
      />
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
