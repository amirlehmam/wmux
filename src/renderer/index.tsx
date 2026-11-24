import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import LockGate from './components/AppLock/LockGate';
import './styles/theme-vars.css';
import './styles/global.css';
import { initNotificationSound } from './notification-sound';

initNotificationSound();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary label="wmux">
      {/* The password lock (#473) sits above the app: locked at startup, the app is not mounted at all. */}
      <LockGate>
        <App />
      </LockGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
