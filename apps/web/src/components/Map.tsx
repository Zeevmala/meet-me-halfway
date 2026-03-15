import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import type { Venue } from "../../../../packages/shared/types";
import type { ParticipantRTDB } from "../hooks/useFirebase";
import { useMapSelection } from "../hooks/useMapSelection";
import "../styles/map.css";
import CentroidMarker from "./CentroidMarker";
import ParticipantPin from "./ParticipantPin";

// lng,lat order — GeoJSON / Mapbox convention
const DEFAULT_CENTER: [number, number] = [35.2137, 31.7683];
const DEFAULT_ZOOM = 8;
const DEFAULT_STYLE = "mapbox://styles/mapbox/standard";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

// RTL text plugin for Hebrew/Arabic labels
try {
  mapboxgl.setRTLTextPlugin(
    "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js",
    true,
  );
} catch {
  /* already loaded */
}

interface MapProps {
  participants: Record<string, ParticipantRTDB>;
  centroid: { lat: number; lng: number } | null;
  venues: Venue[];
  sheetHeight?: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  cafe: "#D4A574",
  coffee_shop: "#D4A574",
  restaurant: "#E85D4A",
  steak_house: "#E85D4A",
  barbecue_restaurant: "#E85D4A",
  park: "#4CAF50",
  bar: "#9C27B0",
  shopping_mall: "#FF9800",
};
const DEFAULT_COLOR = "#607D8B";

function venueColor(types: string[]): string {
  for (const t of types) {
    if (t in CATEGORY_COLORS) return CATEGORY_COLORS[t];
  }
  return DEFAULT_COLOR;
}

function addSourcesAndLayers(map: mapboxgl.Map): void {
  // Route lines (participant → centroid)
  map.addSource("routes", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "routes-layer",
    type: "line",
    source: "routes",
    slot: "top",
    paint: {
      "line-color": "#94a3b8",
      "line-width": 1.5,
      "line-dasharray": [4, 4],
      "line-opacity": 0.5,
    },
  });

  // Venues
  map.addSource("venues", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "venues-layer",
    type: "circle",
    source: "venues",
    slot: "top",
    paint: {
      "circle-radius": 10,
      "circle-color": ["get", "color"],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });
  map.addLayer({
    id: "venues-label",
    type: "symbol",
    source: "venues",
    slot: "top",
    layout: {
      "text-field": ["get", "name"],
      "text-offset": [0, 1.8],
      "text-size": 11,
      "text-anchor": "top",
      "text-max-width": 10,
    },
    paint: {
      "text-color": "#1e293b",
      "text-halo-color": "#fff",
      "text-halo-width": 1.5,
    },
  });
}

export default function Map({
  participants,
  centroid,
  venues,
  sheetHeight = 72,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mapInstance, setMapInstance] = useState<mapboxgl.Map | null>(null);
  const popupRef = useRef<mapboxgl.Popup>(
    new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      className: "venue-hover-popup",
    }),
  );
  const { selectedVenueId, selectVenue, selectionSource } = useMapSelection();

  // ── Map initialization ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const dir = document.dir;
    const controlPos = dir === "rtl" ? "top-left" : "top-right";

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: DEFAULT_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), controlPos);
    map.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
      }),
      controlPos,
    );

    let loaded = false;

    map.on("load", () => {
      addSourcesAndLayers(map);
      loaded = true;
      setMapInstance(map);
    });

    map.on("style.load", () => {
      if (loaded) addSourcesAndLayers(map);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      setMapInstance(null);
    };
  }, []);

  // ── Venue click handler ──
  useEffect(() => {
    if (!mapInstance) return;

    const onClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const placeId = e.features?.[0]?.properties?.place_id;
      if (placeId) selectVenue(placeId, "map");
    };

    const onEnter = () => {
      mapInstance.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      mapInstance.getCanvas().style.cursor = "";
      popupRef.current.remove();
    };

    // Hover tooltip (desktop)
    const onHover = (e: mapboxgl.MapLayerMouseEvent) => {
      if (!e.features?.[0]) return;
      const props = e.features[0].properties!;
      const coords = (e.features[0].geometry as GeoJSON.Point).coordinates as [
        number,
        number,
      ];
      popupRef.current
        .setLngLat(coords)
        .setHTML(`<strong>${props.name}</strong>`)
        .addTo(mapInstance);
    };

    mapInstance.on("click", "venues-layer", onClick);
    mapInstance.on("mouseenter", "venues-layer", onEnter);
    mapInstance.on("mouseleave", "venues-layer", onLeave);
    mapInstance.on("mousemove", "venues-layer", onHover);

    // Click on empty map deselects
    mapInstance.on("click", (e) => {
      const features = mapInstance.queryRenderedFeatures(e.point, {
        layers: ["venues-layer"],
      });
      if (features.length === 0) selectVenue(null);
    });

    return () => {
      mapInstance.off("click", "venues-layer", onClick);
      mapInstance.off("mouseenter", "venues-layer", onEnter);
      mapInstance.off("mouseleave", "venues-layer", onLeave);
      mapInstance.off("mousemove", "venues-layer", onHover);
    };
  }, [mapInstance, selectVenue]);

  // ── Selected venue: enlarge marker + flyTo ──
  useEffect(() => {
    if (!mapInstance || !mapInstance.getLayer("venues-layer")) return;

    const sel = selectedVenueId ?? "";
    mapInstance.setPaintProperty("venues-layer", "circle-radius", [
      "case",
      ["==", ["get", "place_id"], sel],
      14,
      10,
    ]);
    mapInstance.setPaintProperty("venues-layer", "circle-stroke-width", [
      "case",
      ["==", ["get", "place_id"], sel],
      3,
      2,
    ]);

    // FlyTo only when selection came from the list (not the map)
    if (selectedVenueId && selectionSource === "list") {
      const venue = venues.find((v) => v.place_id === selectedVenueId);
      if (venue) {
        mapInstance.flyTo({
          center: [venue.lng, venue.lat],
          zoom: Math.max(mapInstance.getZoom(), 14),
          duration: 800,
          essential: true,
        });
      }
    }
  }, [mapInstance, selectedVenueId, selectionSource, venues]);

  // ── Update venue GeoJSON source ──
  useEffect(() => {
    if (!mapInstance) return;
    const source = mapInstance.getSource("venues") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!source) return;

    const features = venues.map((v, i) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
      properties: {
        name: v.name,
        color: venueColor(v.types),
        place_id: v.place_id,
        index: i,
      },
    }));

    source.setData({ type: "FeatureCollection", features });
  }, [mapInstance, venues]);

  // ── Update route lines (participants → centroid) ──
  useEffect(() => {
    if (!mapInstance || !centroid) return;
    const source = mapInstance.getSource("routes") as
      | mapboxgl.GeoJSONSource
      | undefined;
    if (!source) return;

    const features = Object.values(participants).map((p) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [p.lng, p.lat],
          [centroid.lng, centroid.lat],
        ],
      },
      properties: {},
    }));

    source.setData({ type: "FeatureCollection", features });
  }, [mapInstance, participants, centroid]);

  // ── Map padding for bottom sheet ──
  useEffect(() => {
    if (!mapInstance) return;
    mapInstance.setPadding({ top: 0, left: 0, right: 0, bottom: sheetHeight });
  }, [mapInstance, sheetHeight]);

  // ── Fit bounds to all coordinates ──
  useEffect(() => {
    if (!mapInstance) return;

    const points: [number, number][] = [];
    for (const p of Object.values(participants)) points.push([p.lng, p.lat]);
    if (centroid) points.push([centroid.lng, centroid.lat]);
    for (const v of venues) points.push([v.lng, v.lat]);
    if (points.length < 2) return;

    const lngs = points.map(([lng]) => lng);
    const lats = points.map(([, lat]) => lat);

    mapInstance.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      {
        padding: { top: 64, left: 64, right: 64, bottom: sheetHeight + 32 },
        maxZoom: 15,
        duration: 800,
      },
    );
  }, [mapInstance, participants, centroid, venues, sheetHeight]);

  return (
    <>
      <div ref={containerRef} className="map-container" aria-label="Map" />
      {mapInstance && centroid && (
        <CentroidMarker
          map={mapInstance}
          lat={centroid.lat}
          lng={centroid.lng}
        />
      )}
      {mapInstance &&
        Object.entries(participants).map(([id, p], idx) => (
          <ParticipantPin
            key={id}
            map={mapInstance}
            participantId={id}
            lat={p.lat}
            lng={p.lng}
            displayName={p.display_name}
            colorIndex={idx}
          />
        ))}
    </>
  );
}
