import { useEffect, useState } from "react";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { updateLocation } from "../lib/api";

const LOCATION_TASK = "background-location-task";

// Module-level context: must be accessible inside defineTask (top-level scope)
let _ctx: { sessionId: string; participantId: string } | null = null;

// Must be registered at module top-level — not inside a component or hook
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !_ctx) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const loc = locations[0];
  if (!loc) return;
  try {
    await updateLocation(
      _ctx.sessionId,
      _ctx.participantId,
      loc.coords.latitude,
      loc.coords.longitude
    );
  } catch {
    // Non-fatal — next tick will retry
  }
});

interface LocationState {
  granted: boolean;
  location: Location.LocationObject | null;
}

export function useLocation(
  sessionId: string | null,
  participantId: string | null
): LocationState {
  const [state, setState] = useState<LocationState>({ granted: false, location: null });

  useEffect(() => {
    if (!sessionId || !participantId) return;

    let active = true;

    (async () => {
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (!active) return;

      if (fgStatus !== "granted") {
        setState({ granted: false, location: null });
        return;
      }

      setState((prev) => ({ ...prev, granted: true }));

      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();

      if (bgStatus === "granted") {
        _ctx = { sessionId, participantId };
        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 10_000,
          distanceInterval: 10,
          showsBackgroundLocationIndicator: true,
        });
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (active) setState({ granted: true, location: current });
    })();

    return () => {
      active = false;
      _ctx = null;
      Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
    };
  }, [sessionId, participantId]);

  return state;
}
