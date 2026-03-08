import axios from "axios";
import type {
  MidpointResponse,
  SessionResponse,
} from "@shared/types";

const apiClient = axios.create({
  baseURL: `${process.env.EXPO_PUBLIC_API_URL ?? "https://meetmehalfway.app"}/api/v1`,
  headers: { "Content-Type": "application/json" },
});

export async function getSession(id: string): Promise<SessionResponse> {
  const { data } = await apiClient.get<SessionResponse>(`/sessions/${id}`);
  return data;
}

export async function getMidpoint(sessionId: string): Promise<MidpointResponse> {
  const { data } = await apiClient.get<MidpointResponse>(`/sessions/${sessionId}/midpoint`);
  return data;
}

export async function joinSession(
  sessionId: string,
  displayName: string,
  lat: number,
  lng: number,
  phoneHash?: string
): Promise<{ participant_id: string; session_id: string }> {
  const { data } = await apiClient.post(`/sessions/${sessionId}/join`, {
    display_name: displayName,
    location: { lat, lng },
    phone_hash: phoneHash,
  });
  return data;
}

export async function updateLocation(
  sessionId: string,
  participantId: string,
  lat: number,
  lng: number
): Promise<void> {
  await apiClient.put(`/sessions/${sessionId}/location`, {
    participant_id: participantId,
    location: { lat, lng },
  });
}

export async function voteVenue(
  sessionId: string,
  participantId: string,
  placeId: string,
  venueName?: string
): Promise<{ place_id: string; votes: number }> {
  const { data } = await apiClient.post(`/sessions/${sessionId}/vote`, {
    participant_id: participantId,
    place_id: placeId,
    venue_name: venueName,
  });
  return data;
}

export default apiClient;
