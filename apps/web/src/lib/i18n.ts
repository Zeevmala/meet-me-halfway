import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../i18n/en.json";
import he from "../i18n/he.json";
import ar from "../i18n/ar.json";

const RTL_LOCALES = new Set(["he", "ar"]);

export function applyDocumentDir(lang: string): void {
  document.dir = RTL_LOCALES.has(lang) ? "rtl" : "ltr";
  document.documentElement.lang = lang;
}

const LANG_STORAGE_KEY = "mmh-lang";

function getSavedLanguage(): string {
  try {
    return (
      localStorage.getItem(LANG_STORAGE_KEY) ||
      navigator.language.split("-")[0] ||
      "en"
    );
  } catch {
    return navigator.language.split("-")[0] || "en";
  }
}

const i18n = i18next.use(initReactI18next);

i18n.init({
  resources: {
    en: { translation: en },
    he: { translation: he },
    ar: { translation: ar },
  },
  lng: getSavedLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lang: string) => {
  applyDocumentDir(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* storage unavailable — degrade silently */
  }
});
// Apply on first load
applyDocumentDir(i18n.language);

export default i18n;
