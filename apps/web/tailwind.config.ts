import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#1A73E8",
        secondary: "#FF6D00",
        "venue-cafe": "#D4A574",
        "venue-restaurant": "#E85D4A",
        "venue-park": "#4CAF50",
        "venue-default": "#607D8B",
      },
      fontFamily: {
        sans: ["Inter", "Heebo", "Noto Sans Arabic", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
