import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";
import "../styles/map.css";

interface CentroidMarkerProps {
  map: mapboxgl.Map;
  lat: number;
  lng: number;
}

/** Animated pulsing marker rendered at the computed geodesic centroid. */
export default function CentroidMarker({ map, lat, lng }: CentroidMarkerProps) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.className = "marker-centroid";

    const dot = document.createElement("div");
    dot.className = "marker-centroid-dot";
    el.appendChild(dot);

    // lng,lat order — Mapbox/GeoJSON convention (NOT lat,lng)
    markerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map, lat, lng]);

  return null;
}
