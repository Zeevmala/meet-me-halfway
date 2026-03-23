import { useTranslation } from "react-i18next";

const LANGS: { code: string; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "he", label: "עב", name: "עברית" },
];

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  return (
    <div className="flex gap-1" role="group" aria-label="Language">
      {LANGS.map(({ code, label, name }) => (
        <button
          type="button"
          key={code}
          onClick={() => i18n.changeLanguage(code)}
          aria-pressed={i18n.language === code}
          aria-label={name}
          className={
            i18n.language === code
              ? "min-w-[44px] min-h-[44px] px-3 py-2 text-sm font-semibold rounded bg-blue-600 text-white"
              : "min-w-[44px] min-h-[44px] px-3 py-2 text-sm font-semibold rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}
