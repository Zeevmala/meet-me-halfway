import * as Localization from "expo-localization";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { I18nManager } from "react-native";

const RTL_LOCALES = new Set(["he", "ar"]);

const en = {
  app: { title: "Meet Me Halfway" },
  session: {
    create: "New Session",
    join: "Join Session",
    share: "Share Link",
    expired: "This session has expired",
    loading: "Loading session...",
    error: "Failed to load session",
    participantCount: "{{count}} / {{max}} joined",
    status: { active: "Active", expired: "Expired", completed: "Done" },
  },
  venue: {
    rating: "Rating",
    distance: "{{distance}} away",
    open: "Open now",
    closed: "Closed",
    vote: "Vote",
    votes: "{{count}} votes",
  },
  map: {
    loading: "Loading map...",
    error: "Map failed to load",
    locating: "Finding your location...",
    findingMidpoint: "Finding your meeting point...",
  },
  venues: { title: "Suggested Meeting Places" },
  common: { back: "Back", cancel: "Cancel", confirm: "Confirm" },
};

const he = {
  app: { title: "Meet Me Halfway" },
  session: {
    create: "פגישה חדשה",
    join: "הצטרף לפגישה",
    share: "שתף קישור",
    expired: "הפגישה פגה",
    loading: "טוען פגישה...",
    error: "שגיאה בטעינת הפגישה",
    participantCount: "{{count}} / {{max}} הצטרפו",
    status: { active: "פעיל", expired: "פג תוקף", completed: "הסתיים" },
  },
  venue: {
    rating: "דירוג",
    distance: "{{distance}} מרחק",
    open: "פתוח עכשיו",
    closed: "סגור",
    vote: "הצבע",
    votes: "{{count}} קולות",
  },
  map: {
    loading: "טוען מפה...",
    error: "המפה נכשלה בטעינה",
    locating: "מאתר מיקום...",
    findingMidpoint: "מוצא נקודת מפגש...",
  },
  venues: { title: "מקומות מפגש מוצעים" },
  common: { back: "חזור", cancel: "ביטול", confirm: "אישור" },
};

const ar = {
  app: { title: "Meet Me Halfway" },
  session: {
    create: "جلسة جديدة",
    join: "انضم للجلسة",
    share: "مشاركة الرابط",
    expired: "انتهت صلاحية الجلسة",
    loading: "جار تحميل الجلسة...",
    error: "فشل تحميل الجلسة",
    participantCount: "{{count}} / {{max}} انضموا",
    status: { active: "نشط", expired: "منتهي", completed: "انتهى" },
  },
  venue: {
    rating: "التقييم",
    distance: "{{distance}} بعيد",
    open: "مفتوح الآن",
    closed: "مغلق",
    vote: "تصويت",
    votes: "{{count}} أصوات",
  },
  map: {
    loading: "جار تحميل الخريطة...",
    error: "فشل تحميل الخريطة",
    locating: "جار تحديد موقعك...",
    findingMidpoint: "جار إيجاد نقطة اللقاء...",
  },
  venues: { title: "أماكن الاجتماع المقترحة" },
  common: { back: "رجوع", cancel: "إلغاء", confirm: "تأكيد" },
};

// Determine initial language from device locale
const deviceLang = (Localization.getLocales()[0]?.languageCode ?? "en").toLowerCase();
const supportedLangs = new Set(["en", "he", "ar"]);
const initialLang = supportedLangs.has(deviceLang) ? deviceLang : "en";

function applyRTL(lang: string): void {
  const isRTL = RTL_LOCALES.has(lang);
  // I18nManager.forceRTL triggers a reload on first change — only call when needed
  if (I18nManager.isRTL !== isRTL) {
    I18nManager.forceRTL(isRTL);
  }
}

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    he: { translation: he },
    ar: { translation: ar },
  },
  lng: initialLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18next.on("languageChanged", applyRTL);
applyRTL(initialLang);

export default i18next;
