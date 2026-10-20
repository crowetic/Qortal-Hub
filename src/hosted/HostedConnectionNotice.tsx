import { useEffect, useState } from 'react';
import { Alert } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { hostedClient } from './bootstrap';

export function HostedConnectionNotice() {
  const { t } = useTranslation('reticulum');
  const [state, setState] = useState(hostedClient?.state ?? 'idle');
  useEffect(() => hostedClient?.on('state', setState), []);
  if (state !== 'connecting' && state !== 'disconnected') return null;
  return (
    <Alert
      severity={state === 'connecting' ? 'info' : 'warning'}
      sx={{ position: 'fixed', bottom: 16, left: 16, zIndex: 1600 }}
    >
      {t(
        state === 'connecting'
          ? 'reticulum:hosted.connecting'
          : 'reticulum:hosted.reconnecting'
      )}
    </Alert>
  );
}
