import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import zhTW from './zh-TW';

export type Lang = 'zh-TW' | 'en';

const saved = (() => {
  try {
    return localStorage.getItem('lang') as Lang | null;
  } catch {
    return null;
  }
})();
const initial: Lang = saved ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en');

void i18n.use(initReactI18next).init({
  resources: { 'zh-TW': { translation: zhTW }, en: { translation: en } },
  lng: initial,
  fallbackLng: 'zh-TW',
  interpolation: { escapeValue: false },
});

document.documentElement.lang = initial === 'zh-TW' ? 'zh-Hant' : 'en';

export function setLanguage(lang: Lang) {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : 'en';
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // ignore
  }
}

export default i18n;
