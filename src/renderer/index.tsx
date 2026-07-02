import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/theme-vars.css';
import './styles/global.css';
import { initNotificationSound } from './notification-sound';

initNotificationSound();

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
