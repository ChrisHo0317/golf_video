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
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const sessions = useLiveQuery(() => db.sessions.orderBy('createdAt').reverse().toArray(), []);

  if (!sessions) return null;
  const list = onlyFav ? sessions.filter((s) => s.favorite) : sessions;
  const fmtDate = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const toggleFav = (s: SessionRecord) => db.sessions.update(s.id, { favorite: !s.favorite });
  const remove = (s: SessionRecord) => {
    if (confirm(t('home.confirmDelete', { title: s.title }))) void deleteSession(s.id);
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = list.length > 0 && list.every((s) => selected.has(s.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((s) => s.id)));
  const removeSelected = async () => {
    const ids = list.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (!ids.length || !confirm(t('home.confirmDeleteMany', { n: ids.length }))) return;
    setBusy(true);
    try {
      for (const id of ids) await deleteSession(id);
    } finally {
      setBusy(false);
      exitSelect();
    }
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
        {selectMode ? (
          <>
            <button className="btn small" onClick={toggleAll}>
              {t(allSelected ? 'home.deselectAll' : 'home.selectAll')}
            </button>
            <button className="btn small danger" onClick={removeSelected} disabled={!selected.size || busy}>
              <IconTrash size={16} /> {t('home.deleteSelected', { n: selected.size })}
            </button>
            <button className="btn small" style={{ marginLeft: 'auto' }} onClick={exitSelect}>
              {t('viewer.done')}
            </button>
          </>
        ) : (
          <>
            <button className={`btn small ${onlyFav ? 'active' : ''}`} onClick={() => setOnlyFav(!onlyFav)}>
              <IconStar size={16} filled={onlyFav} /> {t('home.favorite')}
            </button>
            <button className="btn small" onClick={() => setSelectMode(true)}>
              {t('home.select')}
            </button>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {list.length}
            </span>
          </>
        )}
      </div>
      <div className="session-list">
        {list.map((s) => {
          const m = s.metrics;
          const to = s.phases ? `/session/${s.id}` : `/analyze/${s.id}`;
          const checked = selected.has(s.id);
          const info = (
            <>
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
            </>
          );
          return (
            <div key={s.id} className={`card session-card ${checked ? 'selected' : ''}`}>
              {selectMode ? (
                <button
                  className="session-card select-row"
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => toggleOne(s.id)}
                  aria-pressed={checked}
                >
                  <span className={`check ${checked ? 'on' : ''}`} aria-hidden="true" />
                  {info}
                </button>
              ) : (
                <Link to={to} className="session-card" style={{ flex: 1, minWidth: 0 }}>
                  {info}
                </Link>
              )}
              {!selectMode && (
                <div className="stack" style={{ gap: 4 }}>
                  <button className="btn ghost icon-btn" onClick={() => toggleFav(s)} aria-label={t('home.favorite')}>
                    <IconStar filled={s.favorite} />
                  </button>
                  <button className="btn ghost icon-btn danger" onClick={() => remove(s)} aria-label={t('home.delete')}>
                    <IconTrash />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
