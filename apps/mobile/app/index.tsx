import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * Root entry point.
 * Accepts deep links in two forms:
 *   meetmehalfway://s/{id}   (handled by expo-linking scheme)
 *   ?session={id}            (query param fallback)
 * Redirects to the map tab, forwarding the session param.
 */
export default function Index() {
  const params = useLocalSearchParams<{ session?: string }>();
  const sessionId = params.session ?? null;

  if (sessionId) {
    return <Redirect href={`/(tabs)/map?session=${sessionId}`} />;
  }
  return <Redirect href="/(tabs)/map" />;
}
