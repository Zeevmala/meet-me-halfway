export const SESSION_STATUS = {
  ACTIVE: "active",
  EXPIRED: "expired",
  COMPLETED: "completed",
} as const;

export const MAX_PARTICIPANTS = 5;
export const MIN_PARTICIPANTS = 2;
export const DEFAULT_SESSION_TTL_HOURS = 4;

export const MAP_CENTER_ISRAEL = { lng: 35.2137, lat: 31.7683 };

export const SEARCH_RADIUS_MIN_M = 500;
export const SEARCH_RADIUS_MAX_M = 5000;

export const SUPPORTED_LOCALES = ["en", "he", "ar"] as const;
export const DEFAULT_LOCALE = "en";
export const RTL_LOCALES = new Set(["he", "ar"]);

export const VENUE_CATEGORIES = {
  cafe: { color: "#D4A574", icon: "/icons/venue-cafe.svg" },
  restaurant: { color: "#E85D4A", icon: "/icons/venue-restaurant.svg" },
  park: { color: "#4CAF50", icon: "/icons/venue-park.svg" },
  default: { color: "#607D8B", icon: "/icons/venue-default.svg" },
} as const;

export const POI_WEIGHTS = {
  rating: 0.40,
  distance: 0.30,
  popularity: 0.20,
  open_now: 0.10,
} as const;
