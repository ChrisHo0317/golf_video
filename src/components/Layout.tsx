import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { setLanguage, type Lang } from '../i18n';
import { IconBack, IconGear, IconList, IconPlus } from './Icons';
import { PullIndicator, usePullToRefresh } from './PullToRefresh';

export default function Layout() {
  const { t, i18n } = useTranslation();
  const loc = useLocation();
  const nav = useNavigate();
  const isRoot = ['/', '/upload', '/settings'].includes(loc.pathname);
  const mainRef = useRef<HTMLElement>(null);
  const pull = usePullToRefresh(mainRef);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  const nextLang: Lang = i18n.language === 'zh-TW' ? 'en' : 'zh-TW';

  return (
    <div className="app">
      <header className="topbar">
        {!isRoot && (
          <button className="btn ghost icon-btn" onClick={() => nav(-1)} aria-label={t('nav.back')}>
            <IconBack />
          </button>
        )}
        <h1>{t('app.name')}</h1>
        <span className="app-version">v{__APP_VERSION__}</span>
        <button className="btn small" onClick={() => setLanguage(nextLang)} aria-label={t('settings.language')}>
          {nextLang === 'en' ? 'EN' : '中文'}
        </button>
      </header>
      {needRefresh && (
        <div className="notice" style={{ margin: '8px 16px 0' }}>
          {t('settings.update')}{' '}
          <button className="btn small primary" onClick={() => updateServiceWorker(true)}>
            {t('settings.reload')}
          </button>
        </div>
      )}
      <PullIndicator {...pull} />
      <main
        className="main"
        ref={mainRef}
        style={{
          transform: pull.pull ? `translateY(${pull.pull}px)` : undefined,
          // 放開手指後彈回，拖曳中則即時跟手
          transition: pull.pull ? 'none' : 'transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1)',
        }}
      >
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          <IconList />
          {t('nav.home')}
        </NavLink>
        <NavLink to="/upload">
          <IconPlus />
          {t('nav.upload')}
        </NavLink>
        <NavLink to="/settings">
          <IconGear />
          {t('nav.settings')}
        </NavLink>
      </nav>
    </div>
  );
}
