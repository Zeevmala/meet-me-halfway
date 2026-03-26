import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import type { ParticipantIndex } from "../lib/participant-config";
import "../styles/live-midpoint.css";

interface LiveParticipantMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
  participantIndex: ParticipantIndex;
  stale?: boolean;
}

/** Pulsing colored marker for a live participant. */
export default function LiveParticipantMarker({
  map,
  lat,
  lng,
  participantIndex,
  stale = false,
}: LiveParticipantMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = `live-marker live-marker--p${participantIndex}${stale ? " live-marker--stale" : ""}`;

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
  }, [map, lat, lng, participantIndex, stale]);

  return null;
}
