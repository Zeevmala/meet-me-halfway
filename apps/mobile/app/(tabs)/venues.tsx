import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { useSession } from "../../hooks/useSession";
import { voteVenue } from "../../lib/api";
import type { Venue } from "@shared/types";

export default function VenuesScreen() {
  const { session: sessionParam, participant } = useLocalSearchParams<{
    session?: string;
    participant?: string;
  }>();

  const sessionId = sessionParam ?? null;
  const participantId = participant ?? null;

  const { midpoint, loading, error } = useSession(sessionId);
  const [optimisticVotes, setOptimisticVotes] = useState<Record<string, number>>({});

  async function handleVote(venue: Venue) {
    if (!sessionId || !participantId) return;
    // Optimistic update
    setOptimisticVotes((prev) => ({
      ...prev,
      [venue.place_id]: (prev[venue.place_id] ?? 0) + 1,
    }));
    try {
      await voteVenue(sessionId, participantId, venue.place_id, venue.name);
    } catch {
      // Roll back optimistic update on failure
      setOptimisticVotes((prev) => ({
        ...prev,
        [venue.place_id]: Math.max(0, (prev[venue.place_id] ?? 1) - 1),
      }));
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <Text>Loading…</Text>
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

  const venues = midpoint?.venues ?? [];

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Suggested Meeting Places</Text>
      <FlatList
        data={venues}
        keyExtractor={(v) => v.place_id}
        renderItem={({ item: venue }) => (
          <View style={styles.card}>
            <View style={styles.cardInfo}>
              <Text style={styles.venueName}>{venue.name}</Text>
              {venue.vicinity && (
                <Text style={styles.vicinity}>{venue.vicinity}</Text>
              )}
              <View style={styles.meta}>
                {venue.rating != null && (
                  <Text style={styles.metaText}>★ {venue.rating.toFixed(1)}</Text>
                )}
                <Text style={styles.metaText}>
                  {Math.round(venue.distance_to_centroid_m)} m away
                </Text>
                {venue.open_now != null && (
                  <Text
                    style={[
                      styles.metaText,
                      venue.open_now ? styles.open : styles.closed,
                    ]}
                  >
                    {venue.open_now ? "Open" : "Closed"}
                  </Text>
                )}
              </View>
              {optimisticVotes[venue.place_id] != null && (
                <Text style={styles.votes}>
                  {optimisticVotes[venue.place_id]} vote
                  {optimisticVotes[venue.place_id] !== 1 ? "s" : ""}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={styles.voteButton}
              onPress={() => handleVote(venue)}
              accessibilityLabel={`Vote for ${venue.name}`}
            >
              <Text style={styles.voteText}>Vote</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text>No venues yet — waiting for midpoint…</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  header: {
    fontSize: 18,
    fontWeight: "600",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    backgroundColor: "#ffffff",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 8,
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardInfo: { flex: 1 },
  venueName: { fontSize: 16, fontWeight: "600", color: "#111827" },
  vicinity: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  meta: { flexDirection: "row", gap: 10, marginTop: 6, flexWrap: "wrap" },
  metaText: { fontSize: 13, color: "#374151" },
  open: { color: "#16a34a" },
  closed: { color: "#dc2626" },
  votes: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  voteButton: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    marginStart: 10,
  },
  voteText: { color: "#ffffff", fontWeight: "600", fontSize: 14 },
  error: { color: "#dc2626" },
});
