import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";
import type { Role } from "../hooks/useLiveSession";
import LiveParticipantMarker from "./LiveParticipantMarker";
import LiveMidpointMarker from "./LiveMidpointMarker";
import "../styles/live-midpoint.css";

const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683]; // Israel
const DEFAULT_ZOOM = 8;
const DARK_STYLE = "mapbox://styles/mapbox/dark-v11";

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
}

const EMPTY_LINE: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function lineFeature(geom: GeoJSON.LineString): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: geom, properties: {} }],
  };
}

function addSourcesAndLayers(map: mapboxgl.Map): void {
  // Route A → midpoint (green)
  map.addSource("route-a", { type: "geojson", data: EMPTY_LINE });
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
  map.addSource("route-b", { type: "geojson", data: EMPTY_LINE });
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
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);

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
    src.setData(routeA ? lineFeature(routeA) : EMPTY_LINE);
  }, [mapInstance, routeA]);

  // ── Update route B polyline ──
  useEffect(() => {
    if (!mapInstance) return;
    const src = mapInstance.getSource("route-b") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData(routeB ? lineFeature(routeB) : EMPTY_LINE);
  }, [mapInstance, routeB]);

  // ── Fit bounds to all points ──
  useEffect(() => {
    if (!mapInstance) return;

    const points: [number, number][] = [];
    if (posA) points.push([posA.lng, posA.lat]);
    if (posB) points.push([posB.lng, posB.lat]);
    if (midpoint) points.push([midpoint.lng, midpoint.lat]);
    if (points.length < 2) {
      // Single point: just fly to it
      if (points.length === 1) {
        mapInstance.flyTo({
          center: points[0],
          zoom: 14,
          duration: 800,
          essential: true,
        });
      }
      return;
    }

    const lngs = points.map(([lng]) => lng);
    const lats = points.map(([, lat]) => lat);

    mapInstance.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      {
        padding: { top: 80, left: 40, right: 40, bottom: 240 },
        maxZoom: 15,
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
