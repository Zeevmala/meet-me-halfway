import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import { markerRoot } from "./marker-root";
import "../styles/live-midpoint.css";

interface LiveMidpointMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
  /** A venue is picked: the midpoint stays on the map only as a reference. */
  muted?: boolean;
}

/**
 * The meeting point: a place, not a person, so it looks like neither. It used
 * to be a pulsing pink dot — the same shape and pulse as a participant, and
 * the very pink of participant 5. Now it is the app's own mark in white, and
 * still: a pulse is how the map says someone is live.
 */
export default function LiveMidpointMarker({
  map,
  lat,
  lng,
  muted = false,
}: LiveMidpointMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);

  // Effect 1: Create marker once
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "live-marker live-marker--mid";

    markerRef.current = new mapboxgl.Marker({
      element: markerRoot(el),
      anchor: "center",
    })
      .setLngLat([lng, lat])
      .addTo(map);
    elementRef.current = el;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      elementRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- creation only; position handled below
  }, [map]);

  // Effect 2: Update position without recreating DOM
  useEffect(() => {
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  // Effect 3: Toggled, never assigned — see marker-root.ts.
  useEffect(() => {
    elementRef.current?.classList.toggle("live-marker--mid-muted", muted);
  }, [muted]);

  return null;
}
