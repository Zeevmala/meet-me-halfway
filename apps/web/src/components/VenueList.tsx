import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { Venue } from "../../../../packages/shared/types";
import { useMapSelection } from "../hooks/useMapSelection";
import VenueCard from "./VenueCard";

interface VenueListProps {
  venues: Venue[];
  onVenueClick?: (v: Venue) => void;
  onVenueVote?: (placeId: string) => void;
  onHeightChange?: (h: number) => void;
}

const SNAP_COLLAPSED = 72;
const SNAP_HALF_RATIO = 0.45;
const SNAP_FULL_RATIO = 0.85;

function getSnapPoints(): number[] {
  const vh = window.innerHeight;
  return [SNAP_COLLAPSED, vh * SNAP_HALF_RATIO, vh * SNAP_FULL_RATIO];
}

function snapTo(height: number, snaps: number[]): number {
  return snaps.reduce((closest, snap) =>
    Math.abs(snap - height) < Math.abs(closest - height) ? snap : closest,
  );
}

export default function VenueList({
  venues,
  onVenueClick,
  onVenueVote,
  onHeightChange,
}: VenueListProps) {
  const { t } = useTranslation();
  const { selectedVenueId, selectVenue, selectionSource } = useMapSelection();
  const [sheetHeight, setSheetHeight] = useState(SNAP_COLLAPSED);
  const [isSnapping, setIsSnapping] = useState(false);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);

  const isExpanded = sheetHeight > SNAP_COLLAPSED + 10;

  // Notify parent of height changes (for map padding)
  useEffect(() => {
    onHeightChange?.(sheetHeight);
  }, [sheetHeight, onHeightChange]);

  // Auto-expand + scroll to selected card when selection comes from map
  useEffect(() => {
    if (!selectedVenueId || selectionSource !== "map") return;
    const snaps = getSnapPoints();
    if (sheetHeight < snaps[1]) {
      setIsSnapping(true);
      setSheetHeight(snaps[1]);
      setTimeout(() => setIsSnapping(false), 300);
    }
    // Scroll to selected card
    setTimeout(() => {
      const el = cardRefs.current.get(selectedVenueId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
  }, [selectedVenueId, selectionSource, sheetHeight]);

  // ── Drag handlers ──
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    isDragging.current = true;
    startY.current = e.clientY;
    startHeight.current = sheetHeight;
    setIsSnapping(false);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!isDragging.current) return;
    const delta = startY.current - e.clientY;
    const newHeight = Math.max(
      SNAP_COLLAPSED,
      Math.min(window.innerHeight * 0.9, startHeight.current + delta),
    );
    setSheetHeight(newHeight);
  };

  const onPointerUp = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const snaps = getSnapPoints();
    const snapped = snapTo(sheetHeight, snaps);
    setIsSnapping(true);
    setSheetHeight(snapped);
    setTimeout(() => setIsSnapping(false), 300);
  };

  // Toggle on handle click (keyboard / screen reader)
  const onHandleClick = () => {
    if (isDragging.current) return;
    const snaps = getSnapPoints();
    const target = sheetHeight > SNAP_COLLAPSED + 10 ? snaps[0] : snaps[1];
    setIsSnapping(true);
    setSheetHeight(target);
    setTimeout(() => setIsSnapping(false), 300);
  };

  const handleCardClick = useCallback(
    (v: Venue) => {
      selectVenue(v.place_id, "list");
      onVenueClick?.(v);
    },
    [selectVenue, onVenueClick],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, v: Venue) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleCardClick(v);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        (e.currentTarget.nextElementSibling as HTMLElement)?.focus();
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        (e.currentTarget.previousElementSibling as HTMLElement)?.focus();
      }
    },
    [handleCardClick],
  );

  if (venues.length === 0) {
    return (
      <div className="venue-sheet" style={{ height: SNAP_COLLAPSED }}>
        <div className="venue-sheet-handle" style={{ cursor: "default" }}>
          <span className="venue-sheet-grip" />
          <span className="text-sm text-gray-500">{t("venues.empty")}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="venue-list"
      role="list"
      aria-label={t("venues.title")}
      className={`venue-sheet ${isSnapping ? "venue-sheet-snapping" : ""}`}
      style={{ height: sheetHeight }}
    >
      {/* Drag handle */}
      <button
        type="button"
        className="venue-sheet-handle"
        onClick={onHandleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-expanded={isExpanded}
      >
        <span className="venue-sheet-grip" />
        <span className="text-sm font-medium text-gray-700">
          {t("venues.handle", { count: venues.length })}
        </span>
      </button>

      {/* Scrollable venue cards */}
      <div
        ref={bodyRef}
        className="venue-sheet-body"
        style={{ maxHeight: `calc(${sheetHeight}px - 56px)` }}
      >
        {venues.map((v) => (
          <div
            key={v.place_id}
            ref={(el) => {
              if (el) cardRefs.current.set(v.place_id, el);
              else cardRefs.current.delete(v.place_id);
            }}
            role="listitem"
            tabIndex={0}
            onClick={() => handleCardClick(v)}
            onKeyDown={(e) => handleKeyDown(e, v)}
          >
            <VenueCard
              name={v.name}
              rating={v.rating}
              distance_to_centroid_m={v.distance_to_centroid_m}
              open_now={v.open_now}
              score={v.score}
              vicinity={v.vicinity}
              types={v.types}
              user_ratings_total={v.user_ratings_total}
              place_id={v.place_id}
              lat={v.lat}
              lng={v.lng}
              expanded={v.place_id === selectedVenueId}
              selected={v.place_id === selectedVenueId}
              onVote={onVenueVote}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
