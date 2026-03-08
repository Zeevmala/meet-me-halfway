export interface LatLng {
  lat: number;
  lng: number;
}

export interface Participant {
  participant_id: string;
  session_id: string;
  name: string;
  location: LatLng | null;
  joined_at: string;
}

export interface Venue {
  place_id: string;
  name: string;
  lat: number;
  lng: number;
  rating: number | null;
  user_ratings_total: number | null;
  open_now: boolean | null;
  distance_to_centroid_m: number;
  score: number;
  types: string[];
  vicinity: string | null;
}

export interface SessionResponse {
  session_id: string;
  status: string;
  created_at: string;
  expires_at: string;
  participant_count: number;
  max_participants: number;
}

export interface MidpointResponse {
  session_id: string;
  centroid: LatLng;
  search_radius_m: number;
  venues: Venue[];
  participant_count: number;
}
