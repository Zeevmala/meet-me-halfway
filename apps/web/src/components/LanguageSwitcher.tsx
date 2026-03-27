import { useTranslation } from "react-i18next";

const LANGS: { code: string; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "he", label: "עב", name: "עברית" },
];

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  return (
    <div className="live-lang-switcher" role="group" aria-label="Language">
      {LANGS.map(({ code, label, name }) => (
        <button
          type="button"
          key={code}
          onClick={() => i18n.changeLanguage(code)}
          aria-pressed={i18n.language === code}
          aria-label={name}
          className={`live-lang-btn${i18n.language === code ? " live-lang-btn--active" : ""}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
