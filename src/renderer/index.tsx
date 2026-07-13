import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/theme-vars.css';
import './styles/global.css';
import { initNotificationSound } from './notification-sound';

initNotificationSound();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary label="wmux">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
