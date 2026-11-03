import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { ChatDirect } from '../components/Chat/ChatDirect';
import { configuration, onChatEvent, rpc } from './bridge';
import { validateAddress } from '../utils/validateAddress';

/** Reuse Hub's conversation/editor; only the embedded navigation lives here. */
export function DirectChats({ initialPeer = '' }: { initialPeer?: string }) {
  const { t } = useTranslation(['reticulum']);
  const [peer, setPeer] = useState<any>(
    initialPeer ? { address: initialPeer, name: initialPeer } : null
  );
  const [target, setTarget] = useState('');
  const [summaries, setSummaries] = useState<any[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      rpc('getDirectSummaries', [configuration.account.address])
        .then((rows) => {
          if (!cancelled && Array.isArray(rows)) setSummaries(rows);
        })
        .catch(() => {
          if (!cancelled) setError(t('reticulum:nuqloud.request_failed'));
        });
    void refresh();
    const off = onChatEvent('onDirectSummaryChanged', refresh);
    const resync = onChatEvent('onDirectResync', refresh);
    return () => {
      cancelled = true;
      off();
      resync();
    };
  }, [t]);
  useEffect(() => {
    if (initialPeer && validateAddress(initialPeer))
      setPeer({ address: initialPeer, name: initialPeer });
  }, [initialPeer]);
  async function start() {
    const text = target.trim();
    setError('');
    let address = text;
    if (!validateAddress(address)) {
      try {
        const response = await fetch(
          `${configuration.coreUrl}/names/${encodeURIComponent(text)}`,
          { cache: 'no-store', redirect: 'error' }
        );
        if (!response.ok) throw new Error();
        const name = await response.json();
        if (name.name !== text || !validateAddress(name.owner))
          throw new Error();
        address = name.owner;
      } catch {
        setError(t('reticulum:nuqloud.dm_invalid_peer'));
        return;
      }
    }
    setPeer({ address, name: text });
    setTarget('');
  }
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'minmax(0, 1fr) auto',
            sm: 'minmax(0, 1fr) auto auto',
          },
          gap: 1,
          p: 1,
        }}
      >
        <TextField
          size="small"
          fullWidth
          label={t('reticulum:nuqloud.dm_recipient')}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void start();
            }
          }}
          inputProps={{ maxLength: 128 }}
        />
        <Button onClick={() => void start()} disabled={!target.trim()}>
          {t('reticulum:nuqloud.dm_open')}
        </Button>
        {peer && (
          <Button
            sx={{
              gridColumn: { xs: '1 / -1', sm: 'auto' },
              justifySelf: 'start',
            }}
            onClick={() => setPeer(null)}
          >
            {t('reticulum:nuqloud.dm_list')}
          </Button>
        )}
      </Box>
      {error && (
        <Typography role="alert" sx={{ p: 1 }}>
          {error}
        </Typography>
      )}
      {peer ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <ChatDirect
            key={peer.address}
            myAddress={configuration.account.address}
            selectedDirect={peer}
            setSelectedDirect={setPeer}
            isNewChat={false}
            setNewChat={() => {}}
            getTimestampEnterChat={() => {}}
            close={() => setPeer(null)}
            setMobileViewModeKeepOpen={() => {}}
            reticulumEnabled={true}
            reticulumChatEnabled={true}
            embeddedCapabilities={{
              calls: false,
              resources: false,
              friends: false,
            }}
          />
        </Box>
      ) : (
        <List sx={{ overflow: 'auto' }}>
          {!summaries.length && (
            <Typography sx={{ p: 2 }}>
              {t('reticulum:nuqloud.dm_empty')}
            </Typography>
          )}
          {summaries.map((row) => (
            <ListItemButton
              key={row.conversationId}
              onClick={() =>
                setPeer({ address: row.peerAddress, name: row.peerAddress })
              }
            >
              <ListItemText
                primary={row.peerAddress}
                secondary={t('reticulum:nuqloud.dm_unread', {
                  count: row.unreadCount || 0,
                })}
              />
            </ListItemButton>
          ))}
        </List>
      )}
    </Box>
  );
}
