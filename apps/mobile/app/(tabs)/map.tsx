import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View, Text } from "react-native";
import MapboxGL from "@rnmapbox/maps";
import { useEffect, useRef } from "react";

import { useSession } from "../../hooks/useSession";
import { useParticipantLocations } from "../../hooks/useFirebase";
import { useLocation } from "../../hooks/useLocation";
import type { Venue } from "@shared/types";

const MAPBOX_STYLE = "mapbox://styles/mapbox/streets-v12";

export default function MapScreen() {
  const { session: sessionParam, participant } = useLocalSearchParams<{
    session?: string;
    participant?: string;
  }>();

  const sessionId = sessionParam ?? null;
  const participantId = participant ?? null;

  const { session, midpoint, loading, error } = useSession(sessionId);
  const participants = useParticipantLocations(sessionId);
  useLocation(sessionId, participantId);

  const cameraRef = useRef<MapboxGL.Camera>(null);

  // Fit camera to participant bounding box when data changes
  useEffect(() => {
    const locs = Object.values(participants);
    if (locs.length < 2 || !cameraRef.current) return;

    const lngs = locs.map((p) => p.lng);
    const lats = locs.map((p) => p.lat);
    const ne: [number, number] = [Math.max(...lngs), Math.max(...lats)];
    const sw: [number, number] = [Math.min(...lngs), Math.min(...lats)];
    cameraRef.current.fitBounds(ne, sw, [60, 60, 60, 60], 600);
  }, [participants]);

  // GeoJSON for participants
  const participantGeoJSON: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: Object.entries(participants).map(([id, p]) => ({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { display_name: p.display_name },
    })),
  };

  // GeoJSON for centroid
  const centroidGeoJSON: GeoJSON.FeatureCollection | null = midpoint
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [midpoint.centroid.lng, midpoint.centroid.lat],
            },
            properties: {},
          },
        ],
      }
    : null;

  // GeoJSON for venues
  const venueGeoJSON: GeoJSON.FeatureCollection | null =
    midpoint && midpoint.venues.length > 0
      ? {
          type: "FeatureCollection",
          features: midpoint.venues.map((v: Venue) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [v.lng, v.lat] },
            properties: { name: v.name, score: v.score },
          })),
        }
      : null;

  if (loading) {
    return (
      <View style={styles.centered}>
        <Text>Loading session…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapboxGL.MapView style={styles.map} styleURL={MAPBOX_STYLE}>
        <MapboxGL.Camera ref={cameraRef} zoomLevel={10} />

        {/* Participant pins */}
        <MapboxGL.ShapeSource id="participants" shape={participantGeoJSON}>
          <MapboxGL.CircleLayer
            id="participant-circles"
            style={{
              circleRadius: 8,
              circleColor: "#2563eb",
              circleStrokeWidth: 2,
              circleStrokeColor: "#ffffff",
            }}
          />
        </MapboxGL.ShapeSource>

        {/* Centroid */}
        {centroidGeoJSON && (
          <MapboxGL.ShapeSource id="centroid" shape={centroidGeoJSON}>
            <MapboxGL.CircleLayer
              id="centroid-circle"
              style={{
                circleRadius: 12,
                circleColor: "#dc2626",
                circleStrokeWidth: 3,
                circleStrokeColor: "#ffffff",
              }}
            />
          </MapboxGL.ShapeSource>
        )}

        {/* Venue markers */}
        {venueGeoJSON && (
          <MapboxGL.ShapeSource id="venues" shape={venueGeoJSON}>
            <MapboxGL.SymbolLayer
              id="venue-labels"
              style={{
                textField: ["get", "name"],
                textSize: 12,
                textOffset: [0, 1.5],
                textAnchor: "top",
                iconImage: "marker",
              }}
            />
          </MapboxGL.ShapeSource>
        )}
      </MapboxGL.MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { color: "#dc2626" },
});
