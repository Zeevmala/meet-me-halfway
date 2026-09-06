/**
 * The composition root: one place where configuration becomes wired objects.
 *
 * Called once, from `main.tsx`, and handed down through `ServicesProvider`.
 * Everything below this line receives its dependencies; nothing below reaches
 * for `import.meta.env`, a module-level singleton, or `Date.now` directly.
 */
import { createSemaphore, withPermit } from "../core/dag/semaphore";
import type { Semaphore } from "../core/dag/semaphore";
import { createFirebaseServices } from "./firebase-factory";
import type { FirebaseServices } from "./firebase-factory";
import { createPlacesClient } from "../features/live-midpoint/lib/places-api";
import { createDirectionsClient } from "../features/live-midpoint/lib/directions-api";
import type { GraphPorts } from "../features/live-midpoint/graph/ports";
import type { AppConfig } from "./config";

/**
 * Ceiling on concurrent outbound HTTP across every graph node.
 *
 * One route dispatch fans out per occupied slot — five at capacity — and a
 * venue search can be in flight beside it. Browsers cap HTTP/1.1 at six
 * connections per host, and the RTDB WebSocket plus Mapbox tile requests are
 * drawing on the same budget, so leaving the graph unbounded meant route
 * fetches competing with the map's own tiles. Four leaves headroom.
 *
 * This is a bulkhead, not a rate limiter: it bounds simultaneity, while the
 * per-node debounce and `admits` predicates bound frequency.
 */
const MAX_CONCURRENT_REQUESTS = 4;

export interface Services {
  readonly config: AppConfig;
  readonly firebase: FirebaseServices;
  readonly graphPorts: GraphPorts;
  /** Exposed for diagnostics; the ports above already hold it. */
  readonly requestSemaphore: Semaphore;
}

export function createServices(config: AppConfig): Services {
  const requestSemaphore = createSemaphore(MAX_CONCURRENT_REQUESTS);

  // The bulkhead wraps the clients here rather than inside a ResourcePolicy:
  // policies stay declarative records, with no knowledge of global scheduling.
  const searchVenues = withPermit(
    requestSemaphore,
    createPlacesClient(config.places?.apiKey ?? null),
  );
  const fetchRoute = withPermit(
    requestSemaphore,
    createDirectionsClient(config.mapboxToken),
  );

  const graphPorts: GraphPorts = {
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (id) => clearTimeout(id),
    searchVenues,
    fetchRoute,
    placesEnabled: config.places !== null,
  };

  return {
    config,
    firebase: createFirebaseServices(config),
    graphPorts,
    requestSemaphore,
  };
}
