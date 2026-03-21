import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import "../styles/live-midpoint.css";

interface VenueMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
  name: string;
  selected: boolean;
}

/** Map marker for a nearby venue (gray dot / green selected). */
export default function VenueMarker({
  map,
  lat,
  lng,
  name,
  selected,
}: VenueMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = selected
      ? "live-marker--venue-selected"
      : "live-marker--venue";

    const label = document.createElement("div");
    label.className = "live-marker-label";
    label.textContent = name.length > 14 ? name.slice(0, 13) + "\u2026" : name;
    el.appendChild(label);

    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map, lat, lng, name, selected]);

  return null;
}
