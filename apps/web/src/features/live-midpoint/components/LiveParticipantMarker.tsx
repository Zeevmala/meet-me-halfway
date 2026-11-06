import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import type { ParticipantIndex } from "../lib/participant-config";
import { markerRoot } from "./marker-root";
import "../styles/live-midpoint.css";

interface LiveParticipantMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
  participantIndex: ParticipantIndex;
  stale?: boolean;
  /**
   * The letter drawn on the dot, so colour is not the only way to tell people
   * apart. Null for the own marker, which gets a "you are here" ring instead.
   */
  label?: string | null;
  isOwn?: boolean;
}

/** Pulsing colored marker for a live participant. */
export default function LiveParticipantMarker({
  map,
  lat,
  lng,
  participantIndex,
  stale = false,
  label = null,
  isOwn = false,
}: LiveParticipantMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const initialRef = useRef<HTMLSpanElement | null>(null);

  // Effect 1: Create marker once (stable deps only)
  useEffect(() => {
    const el = document.createElement("div");
    el.className = `live-marker live-marker--p${participantIndex}`;

    const ring = document.createElement("div");
    ring.className = "live-marker-ring";
    el.appendChild(ring);

    const initial = document.createElement("span");
    initial.className = "live-marker-initial";
    initial.setAttribute("aria-hidden", "true");
    el.appendChild(initial);

    markerRef.current = new mapboxgl.Marker({
      element: markerRoot(el),
      anchor: "center",
    })
      .setLngLat([lng, lat])
      .addTo(map);
    elementRef.current = el;
    initialRef.current = initial;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      elementRef.current = null;
      initialRef.current = null;
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

  // Effect 4: Who it is — a name can change mid-session.
  useEffect(() => {
    elementRef.current?.classList.toggle("live-marker--own", isOwn);
    if (initialRef.current) initialRef.current.textContent = label ?? "";
  }, [label, isOwn, participantIndex]);

  return null;
}
