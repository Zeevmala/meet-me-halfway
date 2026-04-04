import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";
import { accuracyCircleGeoJSON, haversineDistance } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import {
  PARTICIPANT_COLORS,
  MAX_PARTICIPANTS,
} from "../lib/participant-config";
import type { RankedVenue } from "../lib/venue-ranking";
import LiveParticipantMarker from "./LiveParticipantMarker";
import LiveMidpointMarker from "./LiveMidpointMarker";
import VenueMarker from "./VenueMarker";
import "../styles/live-midpoint.css";

const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683]; // Israel
const DEFAULT_ZOOM = 8;
const DARK_STYLE = "mapbox://styles/mapbox/dark-v11";
const FIT_MOVEMENT_THRESHOLD_M = 50; // Skip refit if all points moved < 50m

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

// RTL text plugin for Hebrew map labels
try {
  mapboxgl.setRTLTextPlugin(
    "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js",
  );
} catch {
  /* already loaded */
}

export interface MapParticipant {
  position: LatLng;
  accuracy: number;
  index: ParticipantIndex;
  isOwn: boolean;
  stale: boolean;
}

interface LiveMapProps {
  participants: MapParticipant[];
  midpoint: LatLng | null;
  routes: (GeoJSON.LineString | null)[];
  venues: RankedVenue[];
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

export default function LiveMap({
  participants,
  midpoint,
  routes,
  venues,
  selectedVenue,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const lastFitRef = useRef<LatLng[]>([]);

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
        | mapboxgl.GeoJSONSource
        | undefined;
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
        | mapboxgl.GeoJSONSource
        | undefined;
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

    const current: LatLng[] = [];
    for (const p of participants) {
      current.push(p.position);
    }
    if (midpoint) current.push(midpoint);
    if (selectedVenue) current.push(selectedVenue.location);

    if (current.length === 0) return;

    // Skip refit when point count unchanged and all moved < threshold
    const prev = lastFitRef.current;
    if (
      prev.length === current.length &&
      prev.length > 0 &&
      prev.every(
        (p, i) => haversineDistance(p, current[i]) < FIT_MOVEMENT_THRESHOLD_M,
      )
    ) {
      return;
    }
    lastFitRef.current = current;

    if (current.length === 1) {
      mapInstance.easeTo({
        center: [current[0].lng, current[0].lat],
        zoom: 14,
        duration: 800,
      });
      return;
    }

    const lngs = current.map((p) => p.lng);
    const lats = current.map((p) => p.lat);

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
