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

export default apiClient;
