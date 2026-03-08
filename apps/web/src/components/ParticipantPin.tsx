import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";

interface ParticipantPinProps {
  map: mapboxgl.Map;
  participantId: string;
  lat: number;
  lng: number;
  displayName: string;
}

export default function ParticipantPin({
  map,
  participantId: _participantId,
  lat,
  lng,
  displayName,
}: ParticipantPinProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = "marker-participant";

    // lng,lat order — Mapbox/GeoJSON convention (NOT lat,lng)
    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .setPopup(
        new mapboxgl.Popup({ offset: 16, closeButton: false }).setText(
          displayName,
        ),
      )
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map, lat, lng, displayName]);

  return null;
}
