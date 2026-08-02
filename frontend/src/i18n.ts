import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/translation.json";
import ja from "./locales/ja/translation.json";

export type SupportedLanguage = "en" | "ja";

export function getSupportedLanguage(language?: string): SupportedLanguage {
  return language?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

if (!i18n.isInitialized) {
  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        ja: { translation: ja },
      },
      supportedLngs: ["en", "ja"],
      fallbackLng: "en",
      load: "languageOnly",
      initAsync: false,
      detection: {
        order: ["localStorage", "navigator"],
        lookupLocalStorage: "arc-tip-jar-language",
        caches: ["localStorage"],
      },
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
    });
}

export default i18n;
