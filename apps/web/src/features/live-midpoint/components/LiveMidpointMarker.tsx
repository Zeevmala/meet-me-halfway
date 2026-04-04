import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import "../styles/live-midpoint.css";

interface LiveMidpointMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
}

/** Pulsing pink marker rendered at the live midpoint. */
export default function LiveMidpointMarker({
  map,
  lat,
  lng,
}: LiveMidpointMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  // Effect 1: Create marker once
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "live-marker live-marker--mid";

    const ring = document.createElement("div");
    ring.className = "live-marker-ring";
    el.appendChild(ring);

    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- creation only; position handled below
  }, [map]);

  // Effect 2: Update position without recreating DOM
  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  return null;
}
