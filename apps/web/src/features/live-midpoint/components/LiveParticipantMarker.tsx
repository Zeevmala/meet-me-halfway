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
  const elementRef = useRef<HTMLDivElement | null>(null);

  // Effect 1: Create marker once (stable deps only)
  useEffect(() => {
    const el = document.createElement("div");
    el.className = `live-marker live-marker--p${participantIndex}`;

    const ring = document.createElement("div");
    ring.className = "live-marker-ring";
    el.appendChild(ring);

    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);
    elementRef.current = el;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      elementRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- creation only; position handled below
  }, [map, participantIndex]);

  // Effect 2: Update position without recreating DOM
  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  // Effect 3: Toggle stale class without recreating DOM
  useEffect(() => {
    elementRef.current?.classList.toggle("live-marker--stale", stale);
  }, [stale]);

  return null;
}
