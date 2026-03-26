/** Shared participant configuration — colors, limits, types. */

export const MAX_PARTICIPANTS = 5;

export type ParticipantIndex = 0 | 1 | 2 | 3 | 4;

export const PARTICIPANT_COLORS = [
  { name: "green", hex: "#00d4aa", rgb: "0, 212, 170" },
  { name: "blue", hex: "#6c8cff", rgb: "108, 140, 255" },
  { name: "orange", hex: "#ff9f43", rgb: "255, 159, 67" },
  { name: "purple", hex: "#a855f7", rgb: "168, 85, 247" },
  { name: "pink", hex: "#f472b6", rgb: "244, 114, 182" },
] as const;
