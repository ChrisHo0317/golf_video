import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_CLUB_LENGTH_CM } from '../core/calibration/calibration';
import { clubLabel, CLUBS } from '../core/clubs';
import { shareOrDownload, timestampName } from '../core/export/share';
import { exportTrainingData } from '../core/export/trainingExport';
import { getClubDetector } from '../core/inference/runInference';
import { setLanguage, type Lang } from '../i18n';
import { exportBackup, importBackup } from '../storage/backup';
import { db } from '../storage/db';
import { requestPersistence, storageEstimate } from '../storage/videoStore';
import { useSettings } from '../store/settings';
import type { ClubType } from '../types';

function fmtBytes(n: number) {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { poseModel, setPoseModel, captureDefaults: cap, setCaptureDefaults } = useSettings();
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [clubModel, setClubModel] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const labelCount = useLiveQuery(() => db.labels.count(), []);

  useEffect(() => {
    void storageEstimate().then(setEst);
    void requestPersistence().then(setPersisted);
    void getClubDetector().then((d) => setClubModel(d ? d.meta.version : null));
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
      void storageEstimate().then(setEst);
    }
  };

  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>{t('settings.title')}</h2>
      {msg && <div className="notice">{msg}</div>}

      <div className="card stack">
        <div className="field">
          <span>{t('settings.language')}</span>
          <div className="segmented">
            {(
              [
                ['zh-TW', '繁體中文'],
                ['en', 'English'],
              ] as [Lang, string][]
            ).map(([l, name]) => (
              <button key={l} aria-pressed={i18n.language === l} onClick={() => setLanguage(l)}>
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>{t('settings.units')}</span>
          <div>{t('settings.metric')}</div>
        </div>
        <div className="field">
          <span>{t('settings.poseModel')}</span>
          <div className="segmented">
            <button aria-pressed={poseModel === 'full'} onClick={() => setPoseModel('full')}>
              {t('settings.poseFull')}
            </button>
            <button aria-pressed={poseModel === 'heavy'} onClick={() => setPoseModel('heavy')}>
              {t('settings.poseHeavy')}
            </button>
          </div>
        </div>
        <div className="field">
          <span>{t('settings.clubModel')}</span>
          <div>{clubModel === undefined ? '…' : (clubModel ?? t('settings.clubModelNone'))}</div>
        </div>
      </div>

      <div className="card stack">
        <strong>{t('settings.defaults')}</strong>
        <div className="grid-2">
          <div className="field">
            <span>{t('upload.handedness')}</span>
            <div className="segmented">
              {(['right', 'left'] as const).map((h) => (
                <button key={h} aria-pressed={cap.handedness === h} onClick={() => setCaptureDefaults({ ...cap, handedness: h })}>
                  {t(`upload.${h}`)}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{t('upload.height')}</span>
            <input type="number" value={cap.heightCm} onChange={(e) => setCaptureDefaults({ ...cap, heightCm: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>{t('upload.club')}</span>
            <select
              value={cap.clubType}
              onChange={(e) => {
                const c = e.target.value as ClubType;
                setCaptureDefaults({ ...cap, clubType: c, clubLengthCm: DEFAULT_CLUB_LENGTH_CM[c] });
              }}
            >
              {CLUBS.map((c) => (
                <option key={c} value={c}>
                  {clubLabel(c, i18n.language)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('upload.clubLength')}</span>
            <input type="number" value={cap.clubLengthCm} onChange={(e) => setCaptureDefaults({ ...cap, clubLengthCm: Number(e.target.value) })} />
          </label>
        </div>
      </div>

      <div className="card stack">
        <strong>{t('settings.storage')}</strong>
        {est && <div>{t('settings.used', { used: fmtBytes(est.usage), quota: fmtBytes(est.quota) })}</div>}
        <div className="muted">
          {t('settings.persist')}：{persisted ? t('settings.persistOn') : t('settings.persistOff')}
        </div>
        <strong>{t('settings.backup')}</strong>
        <div className="row">
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => run('b1', async () => shareOrDownload(await exportBackup(undefined, true), timestampName('swinglab-backup', 'zip')))}
          >
            {t('settings.exportBackup')}
          </button>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => run('b2', async () => shareOrDownload(await exportBackup(undefined, false), timestampName('swinglab-data', 'zip')))}
          >
            {t('settings.exportBackupNoVideo')}
          </button>
          <label className="btn">
            {t('settings.importBackup')}
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f)
                  void run('imp', async () => {
                    const n = await importBackup(f);
                    setMsg(t('settings.imported', { n }));
                  });
              }}
            />
          </label>
        </div>
      </div>

      <div className="card stack">
        <strong>{t('settings.training')}</strong>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.trainingHint')}
        </p>
        <div>{t('settings.labelsCount', { n: labelCount ?? 0 })}</div>
        <div>
          <button
            className="btn"
            disabled={!!busy || !labelCount}
            onClick={() =>
              run('lbl', async () => {
                const blob = await exportTrainingData();
                if (blob) await shareOrDownload(blob, timestampName('clubhead-labels', 'zip'));
              })
            }
          >
            {t('settings.exportLabels')}
          </button>
        </div>
      </div>

      <div className="card stack">
        <strong>{t('settings.about')}</strong>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.aboutText')}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
