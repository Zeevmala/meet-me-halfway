import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";
import { accuracyCircleGeoJSON, haversineDistance } from "../lib/geo-math";
import type { Role } from "../hooks/useLiveSession";
import LiveParticipantMarker from "./LiveParticipantMarker";
import LiveMidpointMarker from "./LiveMidpointMarker";
import "../styles/live-midpoint.css";

const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683]; // Israel
const DEFAULT_ZOOM = 8;
const DARK_STYLE = "mapbox://styles/mapbox/dark-v11";
const FIT_MOVEMENT_THRESHOLD_M = 50; // Skip refit if all points moved < 50m

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

// RTL text plugin for Hebrew/Arabic map labels
try {
  mapboxgl.setRTLTextPlugin(
    "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js",
    // @ts-expect-error mapbox-gl types expect callback but boolean works at runtime
    true,
  );
} catch {
  /* already loaded */
}

interface LiveMapProps {
  posA: LatLng | null;
  posB: LatLng | null;
  midpoint: LatLng | null;
  routeA: GeoJSON.LineString | null;
  routeB: GeoJSON.LineString | null;
  role: Role | null;
  accuracyA: number | null;
  accuracyB: number | null;
  partnerStale: boolean;
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
  // Accuracy circles (rendered below routes)
  map.addSource("accuracy-a", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "accuracy-a-fill",
    type: "fill",
    source: "accuracy-a",
    paint: { "fill-color": "#00d4aa", "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: "accuracy-a-outline",
    type: "line",
    source: "accuracy-a",
    paint: { "line-color": "#00d4aa", "line-width": 1, "line-opacity": 0.3 },
  });

  map.addSource("accuracy-b", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "accuracy-b-fill",
    type: "fill",
    source: "accuracy-b",
    paint: { "fill-color": "#6c8cff", "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: "accuracy-b-outline",
    type: "line",
    source: "accuracy-b",
    paint: { "line-color": "#6c8cff", "line-width": 1, "line-opacity": 0.3 },
  });

  // Route A → midpoint (green, on top of accuracy circles)
  map.addSource("route-a", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "route-a-layer",
    type: "line",
    source: "route-a",
    paint: {
      "line-color": "#00d4aa",
      "line-width": 4,
      "line-opacity": 0.8,
    },
  });

  // Route B → midpoint (blue)
  map.addSource("route-b", { type: "geojson", data: EMPTY_FC });
  map.addLayer({
    id: "route-b-layer",
    type: "line",
    source: "route-b",
    paint: {
      "line-color": "#6c8cff",
      "line-width": 4,
      "line-opacity": 0.8,
    },
  });
}

export default function LiveMap({
  posA,
  posB,
  midpoint,
  routeA,
  routeB,
  role,
  accuracyA,
  accuracyB,
  partnerStale,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const lastFitRef = useRef<LatLng[]>([]);

  // ── Map initialization ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const dir = document.dir;
    const controlPos = dir === "rtl" ? "top-left" : "top-right";

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

  // ── Update route A polyline ──
  useEffect(() => {
    if (!mapInstance) return;
    const src = mapInstance.getSource("route-a") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData(routeA ? lineFeature(routeA) : EMPTY_FC);
  }, [mapInstance, routeA]);

  // ── Update route B polyline ──
  useEffect(() => {
    if (!mapInstance) return;
    const src = mapInstance.getSource("route-b") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData(routeB ? lineFeature(routeB) : EMPTY_FC);
  }, [mapInstance, routeB]);

  // ── Update accuracy circle A ──
  useEffect(() => {
    if (!mapInstance) return;
    const src = mapInstance.getSource("accuracy-a") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData(
      posA && accuracyA
        ? polygonFeature(accuracyCircleGeoJSON(posA, accuracyA))
        : EMPTY_FC,
    );
  }, [mapInstance, posA, accuracyA]);

  // ── Update accuracy circle B ──
  useEffect(() => {
    if (!mapInstance) return;
    const src = mapInstance.getSource("accuracy-b") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData(
      posB && accuracyB
        ? polygonFeature(accuracyCircleGeoJSON(posB, accuracyB))
        : EMPTY_FC,
    );
  }, [mapInstance, posB, accuracyB]);

  // ── Fit bounds to all points (with jitter suppression) ──
  useEffect(() => {
    if (!mapInstance) return;

    const current: LatLng[] = [];
    if (posA) current.push(posA);
    if (posB) current.push(posB);
    if (midpoint) current.push(midpoint);

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
        padding: { top: 80, left: 40, right: 40, bottom: 240 },
        maxZoom: 16,
        duration: 800,
      },
    );
  }, [mapInstance, posA, posB, midpoint]);

  // Determine which position belongs to which role
  const ownPos = role === "a" ? posA : posB;
  const partnerPos = role === "a" ? posB : posA;

  return (
    <>
      <div
        ref={containerRef}
        className="live-map-container"
        aria-label="Live map"
      />
      {mapInstance && ownPos && (
        <LiveParticipantMarker
          map={mapInstance}
          lat={ownPos.lat}
          lng={ownPos.lng}
          role={role ?? "a"}
        />
      )}
      {mapInstance && partnerPos && (
        <LiveParticipantMarker
          map={mapInstance}
          lat={partnerPos.lat}
          lng={partnerPos.lng}
          role={role === "a" ? "b" : "a"}
          stale={partnerStale}
        />
      )}
      {mapInstance && midpoint && (
        <LiveMidpointMarker
          map={mapInstance}
          lat={midpoint.lat}
          lng={midpoint.lng}
        />
      )}
    </>
  );
}
