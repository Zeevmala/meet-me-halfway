import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { Venue } from "../../../../packages/shared/types";
import type { ParticipantRTDB } from "../hooks/useFirebase";
import "../styles/map.css";
import CentroidMarker from "./CentroidMarker";
import ParticipantPin from "./ParticipantPin";
import VenueMarker from "./VenueMarker";

// lng,lat order — GeoJSON / Mapbox convention
const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683];
const DEFAULT_ZOOM = 8;

const LIGHT_STYLE = "mapbox://styles/mapbox/streets-v12";
const DARK_STYLE = "mapbox://styles/mapbox/dark-v11";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface MapProps {
  participants: Record<string, ParticipantRTDB>;
  centroid: { lat: number; lng: number } | null;
  venues: Venue[];
}

function getPreferredStyle(): string {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? DARK_STYLE
    : LIGHT_STYLE;
}

function addSourcesAndLayers(map: mapboxgl.Map): void {
  map.addSource("participants", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("centroid", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("venues", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "participants-layer",
    type: "circle",
    source: "participants",
    paint: {
      "circle-radius": 8,
      "circle-color": "#3b82f6",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });

  map.addLayer({
    id: "centroid-layer",
    type: "circle",
    source: "centroid",
    paint: {
      "circle-radius": 12,
      "circle-color": "#1a73e8",
      "circle-stroke-width": 3,
      "circle-stroke-color": "#fff",
      "circle-opacity": 0.9,
    },
  });

  map.addLayer({
    id: "venues-layer",
    type: "circle",
    source: "venues",
    paint: {
      "circle-radius": 10,
      "circle-color": ["get", "markerColor"],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });
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

    map.on("load", () => {
      addSourcesAndLayers(map);
      setMapInstance(map);
    });

    // Dark mode switching via matchMedia listener
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleColorSchemeChange = (e: MediaQueryListEvent) => {
      const newStyle = e.matches ? DARK_STYLE : LIGHT_STYLE;
      map.setStyle(newStyle);
    };
    mq.addEventListener("change", handleColorSchemeChange);

    // Re-add sources/layers after style switch
    map.on("style.load", () => {
      if (!map.getSource("participants")) {
        addSourcesAndLayers(map);
      }
    });

    mapRef.current = map;

    return () => {
      mq.removeEventListener("change", handleColorSchemeChange);
      map.remove();
      mapRef.current = null;
      setMapInstance(null);
    };
  }, []);

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
      {mapInstance &&
        Object.entries(participants).map(([id, p]) => (
          <ParticipantPin
            key={id}
            map={mapInstance}
            participantId={id}
            lat={p.lat}
            lng={p.lng}
            displayName={p.display_name}
          />
        ))}
      {mapInstance &&
        venues.map((v) => (
          <VenueMarker
            key={v.place_id}
            map={mapInstance}
            lat={v.lat}
            lng={v.lng}
            name={v.name}
            types={v.types}
          />
        ))}
    </>
  );
}
