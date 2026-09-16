import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from '../components/Layout';
import AnalyzePage from '../pages/AnalyzePage';
import HomePage from '../pages/HomePage';
import SettingsPage from '../pages/SettingsPage';
import UploadPage from '../pages/UploadPage';
import ViewerPage from '../pages/ViewerPage';
import { useSettings } from '../store/settings';
import { requestPersistence } from '../storage/videoStore';

export default function App() {
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);

  useEffect(() => {
    void load();
    void requestPersistence();
  }, [load]);

  if (!loaded) return null;

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="analyze/:id" element={<AnalyzePage />} />
          <Route path="session/:id" element={<ViewerPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
