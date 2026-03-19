import { useTranslation } from "react-i18next";

const LANGS: { code: string; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "he", label: "עב" },
  { code: "ar", label: "ع" },
];

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  return (
    <div className="flex gap-1">
      {LANGS.map(({ code, label }) => (
        <button
          type="button"
          key={code}
          onClick={() => i18n.changeLanguage(code)}
          aria-pressed={i18n.language === code}
          className={
            i18n.language === code
              ? "px-2 py-1 text-xs font-semibold rounded bg-blue-600 text-white"
              : "px-2 py-1 text-xs font-semibold rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}
