import { createRoot } from 'react-dom/client';
import './utils/configureDomPurify';
import App from './App.tsx';
import '../src/styles/index.css';
import './messaging/MessagesToBackground.tsx';
import { MessageQueueProvider } from './messaging/MessageQueueContext.tsx';
import { ThemeProvider } from './components/Theme/ThemeContext.tsx';
import { CssBaseline } from '@mui/material';
import './i18n/i18n.js';
import i18n from './i18n/i18n.js';
import { initializeHosted } from './hosted/bootstrap';
import { HostedConnectionNotice } from './hosted/HostedConnectionNotice';

initializeHosted()
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <>
        <ThemeProvider>
          <CssBaseline />
          <MessageQueueProvider>
            <App />
            <HostedConnectionNotice />
          </MessageQueueProvider>
        </ThemeProvider>
      </>
    )
  )
  .catch(() => {
    document.getElementById('root')!.textContent = i18n.t(
      'reticulum:hosted.invalid_config'
    );
  });
