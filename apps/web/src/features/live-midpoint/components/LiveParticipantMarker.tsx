import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import type { Role } from "../hooks/useLiveSession";
import "../styles/live-midpoint.css";

interface LiveParticipantMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
  role: Role;
  stale?: boolean;
}

/** Pulsing colored marker for a live participant (green A / blue B). */
export default function LiveParticipantMarker({
  map,
  lat,
  lng,
  role,
  stale = false,
}: LiveParticipantMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = `live-marker live-marker--${role}${stale ? " live-marker--stale" : ""}`;

    const ring = document.createElement("div");
    ring.className = "live-marker-ring";
    el.appendChild(ring);

    // lng,lat order — Mapbox/GeoJSON convention
    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map, lat, lng, role, stale]);

  return null;
}
