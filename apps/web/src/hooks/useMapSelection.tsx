import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

interface MapSelectionState {
  selectedVenueId: string | null;
  selectVenue: (placeId: string | null, source?: "map" | "list") => void;
  hoveredVenueId: string | null;
  hoverVenue: (placeId: string | null) => void;
  /** Source of last selection — "map" or "list" */
  selectionSource: "map" | "list" | null;
}

const MapSelectionContext = createContext<MapSelectionState | null>(null);

export function MapSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [hoveredVenueId, setHoveredVenueId] = useState<string | null>(null);
  const [selectionSource, setSelectionSource] = useState<"map" | "list" | null>(
    null,
  );

  const selectVenue = useCallback(
    (placeId: string | null, source: "map" | "list" = "list") => {
      setSelectedVenueId((prev) => (prev === placeId ? null : placeId));
      setSelectionSource(placeId ? source : null);
    },
    [],
  );

  const hoverVenue = useCallback((placeId: string | null) => {
    setHoveredVenueId(placeId);
  }, []);

  return (
    <MapSelectionContext.Provider
      value={{
        selectedVenueId,
        selectVenue,
        hoveredVenueId,
        hoverVenue,
        selectionSource,
      }}
    >
      {children}
    </MapSelectionContext.Provider>
  );
}

export function useMapSelection(): MapSelectionState {
  const ctx = useContext(MapSelectionContext);
  if (!ctx)
    throw new Error("useMapSelection must be used within MapSelectionProvider");
  return ctx;
}
