import { useState } from "react";
import type { FormEvent } from "react";
import { t } from "../../../strings";
import { chosenDisplayName } from "../lib/display-name";
import LegalLinks from "./LegalLinks";
import "../styles/live-midpoint.css";

interface StartScreenProps {
  /** The link named a session: this is an invitation, not a new session. */
  joining: boolean;
  /** The person agreed. `name` is what they typed, "" to keep the default. */
  onStart: (name: string) => void;
}

/**
 * What the app does with a location, said before it asks for one.
 *
 * The page used to open on the browser's location prompt, over "Connecting",
 * and joined the session as it loaded: for someone sent a link, the first
 * thing this app ever said was "allow location?". Nothing is asked for,
 * signed in to or written here until the button is tapped — which also makes
 * the location request one made inside a tap, the only kind Chrome on Android
 * will answer with its "turn on location" dialog instead of a refusal.
 *
 * The name is here because it is the one moment people will set it: left to
 * the badge, two phones in a session were both "iPhone".
 */
export default function StartScreen({ joining, onStart }: StartScreenProps) {
  const [name, setName] = useState(chosenDisplayName);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onStart(name.trim());
  };

  return (
    <main className="live-page">
      <div className="live-start">
        <form className="live-start-card live-glass" onSubmit={handleSubmit}>
          <img
            className="live-start-mark"
            src="/icons/midpoint-pin.svg"
            alt=""
            width="56"
            height="56"
          />
          <h1 className="live-start-title">{t("app.title")}</h1>
          <p className="live-start-lead">
            {t(joining ? "start.joinLead" : "start.createLead")}
          </p>

          <ul className="live-start-points">
            <li>{t("start.pointShare")}</li>
            <li>{t("start.pointStop")}</li>
            <li>{t("start.pointSession")}</li>
          </ul>

          <label className="live-start-name">
            <span className="live-start-name-label">
              {t("start.nameLabel")}
            </span>
            <input
              className="live-start-input"
              type="text"
              name="name"
              value={name}
              maxLength={20}
              autoComplete="nickname"
              placeholder={t("start.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <button
            type="submit"
            className="live-btn live-btn-primary live-start-btn"
          >
            {t(joining ? "start.join" : "start.create")}
          </button>
        </form>
        <LegalLinks />
      </div>
    </main>
  );
}
