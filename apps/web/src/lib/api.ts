import axios from "axios";
import type {
  MidpointResponse,
  SessionResponse,
} from "../../../../packages/shared/types";

const apiClient = axios.create({
  baseURL: "/api/v1",
  headers: { "Content-Type": "application/json" },
});

export async function getSession(id: string): Promise<SessionResponse> {
  const { data } = await apiClient.get<SessionResponse>(`/sessions/${id}`);
  return data;
}

export async function getMidpoint(
  sessionId: string,
): Promise<MidpointResponse> {
  const { data } = await apiClient.get<MidpointResponse>(
    `/sessions/${sessionId}/midpoint`,
  );
  return data;
}

/* ── Vote ── */

export interface VotePayload {
  participant_id: string;
  place_id: string;
  venue_name?: string;
  venue_lat?: number;
  venue_lng?: number;
}

export interface VoteResult {
  place_id: string;
  votes: number;
}

export async function voteVenue(
  sessionId: string,
  payload: VotePayload,
): Promise<VoteResult> {
  const { data } = await apiClient.post<VoteResult>(
    `/sessions/${sessionId}/vote`,
    payload,
  );
  return data;
}

/* ── Join ── */

export interface JoinPayload {
  display_name: string;
  location: { lat: number; lng: number };
}

export interface JoinResult {
  participant_id: string;
  session_id: string;
}

export async function joinSession(
  sessionId: string,
  payload: JoinPayload,
): Promise<JoinResult> {
  const { data } = await apiClient.post<JoinResult>(
    `/sessions/${sessionId}/join`,
    payload,
  );
  return data;
}

/* ── Location update ── */

export async function updateLocation(
  sessionId: string,
  participantId: string,
  location: { lat: number; lng: number },
): Promise<void> {
  await apiClient.put(`/sessions/${sessionId}/location`, {
    participant_id: participantId,
    location,
  });
}

export default apiClient;
