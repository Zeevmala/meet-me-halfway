import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";

const PARTICIPANT_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
];

interface ParticipantPinProps {
  map: mapboxgl.Map;
  participantId: string;
  lat: number;
  lng: number;
  displayName: string;
  colorIndex: number;
}

export default function ParticipantPin({
  map,
  participantId: _participantId,
  lat,
  lng,
  displayName,
  colorIndex,
}: ParticipantPinProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = "marker-participant";
    el.style.background =
      PARTICIPANT_COLORS[colorIndex % PARTICIPANT_COLORS.length];
    el.textContent = displayName.charAt(0).toUpperCase();

    // lng,lat order — Mapbox/GeoJSON convention (NOT lat,lng)
    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .setPopup(
        new mapboxgl.Popup({
          offset: 20,
          closeButton: false,
          className: "venue-hover-popup",
        }).setText(displayName),
      )
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map, lat, lng, displayName, colorIndex]);

  return null;
}
