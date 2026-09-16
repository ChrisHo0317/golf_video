import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { IconStar, IconTrash } from '../components/Icons';
import { db, deleteSession } from '../storage/db';
import type { SessionRecord } from '../types';

function Thumb({ blob }: { blob: Blob | null }) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url ? <img src={url} alt="" /> : <div className="thumb" />;
}

export default function HomePage() {
  const { t, i18n } = useTranslation();
  const [onlyFav, setOnlyFav] = useState(false);
  const sessions = useLiveQuery(() => db.sessions.orderBy('createdAt').reverse().toArray(), []);

  if (!sessions) return null;
  const list = onlyFav ? sessions.filter((s) => s.favorite) : sessions;
  const fmtDate = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const toggleFav = (s: SessionRecord) => db.sessions.update(s.id, { favorite: !s.favorite });
  const remove = (s: SessionRecord) => {
    if (confirm(t('home.confirmDelete', { title: s.title }))) void deleteSession(s.id);
  };

  if (!sessions.length) {
    return (
      <div className="card empty stack">
        <h2 style={{ margin: 0 }}>{t('home.empty')}</h2>
        <p className="muted">{t('home.emptyHint')}</p>
        <div>
          <Link className="btn primary" to="/upload">
            {t('home.start')}
          </Link>
        </div>
        <p className="muted">{t('app.tagline')}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <button className={`btn small ${onlyFav ? 'active' : ''}`} onClick={() => setOnlyFav(!onlyFav)}>
          <IconStar size={16} filled={onlyFav} /> {t('home.favorite')}
        </button>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {list.length}
        </span>
      </div>
      <div className="session-list">
        {list.map((s) => {
          const m = s.metrics;
          const to = s.phases ? `/session/${s.id}` : `/analyze/${s.id}`;
          return (
            <div key={s.id} className="card session-card">
              <Link to={to} className="session-card" style={{ flex: 1, minWidth: 0 }}>
                <Thumb blob={s.thumbnail} />
                <div className="info">
                  <div className="title">{s.title}</div>
                  <div className="muted">{fmtDate.format(s.createdAt)}</div>
                  <div className="chips">
                    <span className="chip">{t(`upload.${s.capture.handedness}`)}</span>
                    {m?.tempoRatio != null && <span className="chip">{m.tempoRatio.toFixed(1)}:1</span>}
                    {m?.clubSpeedMax != null && <span className="chip">{m.clubSpeedMax.toFixed(1)} m/s</span>}
                    {!s.phases && <span className="chip">{t('home.unanalyzed')}</span>}
                  </div>
                </div>
              </Link>
              <div className="stack" style={{ gap: 4 }}>
                <button className="btn ghost icon-btn" onClick={() => toggleFav(s)} aria-label={t('home.favorite')}>
                  <IconStar filled={s.favorite} />
                </button>
                <button className="btn ghost icon-btn danger" onClick={() => remove(s)} aria-label={t('home.delete')}>
                  <IconTrash />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
