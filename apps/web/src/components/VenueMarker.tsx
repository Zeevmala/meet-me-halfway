import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import "../styles/map.css";

/** Category → marker fill color mapping. */
const CATEGORY_COLORS: Record<string, string> = {
  cafe: "#D4A574",
  restaurant: "#E85D4A",
  park: "#4CAF50",
};
const DEFAULT_COLOR = "#607D8B";

function markerColor(types: string[]): string {
  for (const t of types) {
    if (t in CATEGORY_COLORS) return CATEGORY_COLORS[t];
  }
  return DEFAULT_COLOR;
}

interface VenueMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
  name: string;
  types: string[];
  onClick?: () => void;
}

/** Category-colored animated venue marker with popup. */
export default function VenueMarker({
  map,
  lat,
  lng,
  name,
  types,
  onClick,
}: VenueMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const color = markerColor(types);

    const el = document.createElement("div");
    el.className = "marker-venue";
    el.style.cssText = `
      width: 32px; height: 32px;
      border-radius: 50% 50% 50% 0;
      background: ${color};
      border: 3px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      transform: rotate(-45deg);
      cursor: pointer;
    `;
    if (onClick) el.addEventListener("click", onClick);

    const popup = new mapboxgl.Popup({
      offset: 24,
      closeButton: false,
    }).setText(name);

    // lng,lat order — Mapbox/GeoJSON convention (NOT lat,lng)
    markerRef.current = new mapboxgl.Marker({
      element: el,
      anchor: "bottom-left",
    })
      .setLngLat([lng, lat])
      .setPopup(popup)
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map, lat, lng, name, types, onClick]);

  return null;
}
