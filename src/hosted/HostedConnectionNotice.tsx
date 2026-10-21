import { useEffect, useState } from 'react';
import { Alert } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { hostedClient } from './bootstrap';
import type { HostedRequestError } from './errors';

export function HostedConnectionNotice() {
  const { t } = useTranslation(['reticulum', 'core']);
  const [state, setState] = useState(hostedClient?.state ?? 'idle');
  const [error, setError] = useState<HostedRequestError>();
  useEffect(() => {
    const stateListener = hostedClient?.on('state', (next) => {
      setState(next);
      if (next === 'idle' || next === 'connected') setError(undefined);
    });
    const errorListener = hostedClient?.on('request-error', setError);
    return () => {
      stateListener?.();
      errorListener?.();
    };
  }, []);
  const connecting = state === 'connecting';
  const disconnected = state === 'disconnected';
  if (!connecting && !disconnected && !error) return null;
  return (
    <Alert
      severity={connecting ? 'info' : 'warning'}
      closeText={t('core:action.close', { postProcess: 'capitalizeFirstChar' })}
      onClose={
        !connecting && !disconnected ? () => setError(undefined) : undefined
      }
      sx={{ position: 'fixed', bottom: 16, left: 16, zIndex: 1600 }}
    >
      {connecting || disconnected
        ? t(
            connecting
              ? 'reticulum:hosted.connecting'
              : 'reticulum:hosted.reconnecting'
          )
        : error?.message}
    </Alert>
  );
}
