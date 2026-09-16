import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './styles.css';
import 'uplot/dist/uPlot.min.css';
import App from './app/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
