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
  const elementRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);

  // Effect 1: Create marker once per venue identity (map + name)
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "live-marker--venue";

    const label = document.createElement("div");
    label.className = "live-marker-label";
    label.textContent = name.length > 14 ? name.slice(0, 13) + "\u2026" : name;
    el.appendChild(label);

    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);
    elementRef.current = el;
    labelRef.current = label;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      elementRef.current = null;
      labelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- creation only; position/selection handled below
  }, [map, name]);

  // Effect 2: Update position without recreating DOM
  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  // Effect 3: Toggle selected class without recreating DOM
  useEffect(() => {
    if (elementRef.current) {
      elementRef.current.className = selected
        ? "live-marker--venue-selected"
        : "live-marker--venue";
    }
  }, [selected]);

  return null;
}
