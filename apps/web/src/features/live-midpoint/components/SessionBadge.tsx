import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionPhase } from "../hooks/useLiveSession";
import type { ParticipantIndex } from "../lib/participant-config";
import { firstLetter, isDerivedName } from "../lib/display-name";
import "../styles/live-midpoint.css";

interface SessionBadgeProps {
  code: string;
  phase: SessionPhase;
  ownConnected: boolean;
  ownIndex: ParticipantIndex;
  ownName: string;
  onNameChange: (name: string) => void;
  participants: Array<{
    index: ParticipantIndex;
    connected: boolean;
    name: string | null;
  }>;
}

/** Top bar overlay: session code, live dot, participant status pills. */
export default memo(function SessionBadge({
  code,
  phase,
  ownConnected,
  ownIndex,
  ownName,
  onNameChange,
  participants,
}: SessionBadgeProps) {
  const { t } = useTranslation();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = useCallback(() => {
    setDraft(ownName);
    setEditing(true);
  }, [ownName]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== ownName) {
      onNameChange(trimmed);
    }
    setEditing(false);
  }, [draft, ownName, onNameChange]);

  const cancel = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  // Show the chosen name; fall back to a generic "You" for the auto-derived
  // device label so the self pill never reads as a cryptic OS initial.
  const ownLabel =
    ownName.trim().length > 0 && !isDerivedName(ownName)
      ? ownName
      : t("live.you");

  return (
    <header className="live-badge live-glass">
      <span className="live-badge-code">{code}</span>
      {(phase === "connected" || phase === "some_stale") && (
        <span className="live-badge-dot" aria-label={t("live.liveIndicator")} />
      )}
      <div className="live-badge-pills">
        {editing ? (
          <span className="live-pill live-pill--editing">
            <span
              className={`live-pill-dot ${ownConnected ? `live-pill-dot--p${ownIndex}` : "live-pill-dot--gray"}`}
            />
            <input
              ref={inputRef}
              className="live-pill-input"
              type="text"
              value={draft}
              maxLength={20}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={handleKeyDown}
              aria-label={t("live.editName")}
            />
          </span>
        ) : (
          <button
            type="button"
            className="live-pill live-pill--editable"
            onClick={startEdit}
            aria-label={t("live.editName")}
          >
            <span
              className={`live-pill-dot ${ownConnected ? `live-pill-dot--p${ownIndex}` : "live-pill-dot--gray"}`}
            />
            <span className="live-pill-label">{ownLabel}</span>
          </button>
        )}
        {participants.map((p) => {
          const letter = firstLetter(p.name) ?? String(p.index + 1);
          return (
            <div key={p.index} className="live-pill">
              <span
                className={`live-pill-dot ${p.connected ? `live-pill-dot--p${p.index}` : "live-pill-dot--gray"}`}
              />
              {letter}
            </div>
          );
        })}
      </div>
    </header>
  );
});
