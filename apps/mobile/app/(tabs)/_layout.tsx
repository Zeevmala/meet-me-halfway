import { Tabs } from "expo-router";
import { useEffect } from "react";
import Mapbox from "@rnmapbox/maps";

/**
 * Tab navigator root.
 * Mapbox token must be set before any MapView renders — do it here once.
 */
export default function TabLayout() {
  useEffect(() => {
    Mapbox.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "");
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#2563eb",
      }}
    >
      <Tabs.Screen
        name="map"
        options={{
          title: "Map",
          tabBarIcon: ({ color, size }) => (
            // Inline SVG-style placeholder — swap for a proper icon library
            // once @expo/vector-icons is added.
            null
          ),
        }}
      />
      <Tabs.Screen
        name="venues"
        options={{
          title: "Venues",
          tabBarIcon: ({ color, size }) => null,
        }}
      />
    </Tabs>
  );
}
