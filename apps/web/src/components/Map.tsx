import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { Venue } from "../../../../packages/shared/types";
import type { ParticipantRTDB } from "../hooks/useFirebase";
import "../styles/map.css";
import CentroidMarker from "./CentroidMarker";

// lng,lat order — GeoJSON / Mapbox convention
const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683];
const DEFAULT_ZOOM = 8;

const DEFAULT_STYLE = "mapbox://styles/mapbox/standard";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface MapProps {
  participants: Record<string, ParticipantRTDB>;
  centroid: { lat: number; lng: number } | null;
  venues: Venue[];
}

function getPreferredStyle(): string {
  return DEFAULT_STYLE;
}

function addSourcesAndLayers(map: mapboxgl.Map): void {
  map.addSource("participants", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("venues", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Participants: blue circles
  map.addLayer({
    id: "participants-layer",
    type: "circle",
    source: "participants",
    slot: "top",
    paint: {
      "circle-radius": 8,
      "circle-color": "#3b82f6",
      "circle-stroke-width": 3,
      "circle-stroke-color": "#fff",
    },
  });

  // Participant labels
  map.addLayer({
    id: "participants-label",
    type: "symbol",
    source: "participants",
    slot: "top",
    layout: {
      "text-field": ["get", "name"],
      "text-offset": [0, 1.5],
      "text-size": 12,
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#fff",
      "text-halo-color": "#000",
      "text-halo-width": 1,
    },
  });

  // Venues: colored circles with white stroke
  map.addLayer({
    id: "venues-layer",
    type: "circle",
    source: "venues",
    slot: "top",
    paint: {
      "circle-radius": 10,
      "circle-color": ["get", "color"],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });

  // Venue labels
  map.addLayer({
    id: "venues-label",
    type: "symbol",
    source: "venues",
    slot: "top",
    layout: {
      "text-field": ["get", "name"],
      "text-offset": [0, 1.8],
      "text-size": 11,
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#fff",
      "text-halo-color": "#000",
      "text-halo-width": 1,
    },
  });
}

const CATEGORY_COLORS: Record<string, string> = {
  cafe: "#D4A574",
  restaurant: "#E85D4A",
  park: "#4CAF50",
};
const DEFAULT_COLOR = "#607D8B";

function venueColor(types: string[]): string {
  for (const t of types) {
    if (t in CATEGORY_COLORS) return CATEGORY_COLORS[t];
  }
  return DEFAULT_COLOR;
}

export default function Map({ participants, centroid, venues }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: getPreferredStyle(),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
      }),
      "top-right",
    );

    let loaded = false;

    map.on("load", () => {
      addSourcesAndLayers(map);
      loaded = true;
      setMapInstance(map);
    });

    // Re-add sources/layers after dark mode style switch
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

  // Update participant GeoJSON source
  useEffect(() => {
    if (!mapInstance) return;
    const source = mapInstance.getSource("participants") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!source) return;

    const features = Object.entries(participants).map(([id, p]) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: { id, name: p.display_name },
    }));

    source.setData({ type: "FeatureCollection", features });
  }, [mapInstance, participants]);

  // Update venue GeoJSON source
  useEffect(() => {
    if (!mapInstance) return;
    const source = mapInstance.getSource("venues") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!source) return;

    const features = venues.map((v) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
      properties: {
        name: v.name,
        color: venueColor(v.types),
        place_id: v.place_id,
      },
    }));

    source.setData({ type: "FeatureCollection", features });
  }, [mapInstance, venues]);

  // Fit bounds to all known coordinates when data changes
  useEffect(() => {
    if (!mapInstance) return;

    const points: [number, number][] = [];

    for (const p of Object.values(participants)) {
      points.push([p.lng, p.lat]);
    }
    if (centroid) {
      points.push([centroid.lng, centroid.lat]);
    }
    for (const v of venues) {
      points.push([v.lng, v.lat]);
    }

    if (points.length < 2) return;

    const lngs = points.map(([lng]) => lng);
    const lats = points.map(([, lat]) => lat);

    mapInstance.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 64, maxZoom: 15, duration: 800 },
    );
  }, [mapInstance, participants, centroid, venues]);

  return (
    <>
      <div ref={containerRef} className="map-container" aria-label="Map" />
      {mapInstance && centroid && (
        <CentroidMarker
          map={mapInstance}
          lat={centroid.lat}
          lng={centroid.lng}
        />
      )}
    </>
  );
}
