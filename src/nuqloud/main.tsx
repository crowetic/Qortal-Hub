import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { Provider, createStore, useStore } from 'jotai';
import {
  Box,
  Button,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Snackbar,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import '../utils/configureDomPurify';
import './messages';
import {
  initializeBridge,
  configuration,
  invalidateChat,
  onChatEvent,
  parentRequest,
  rpc,
} from './bridge';
import { ChatGroup } from '../components/Chat/ChatGroup';
import { ThemeProvider } from '../components/Theme/ThemeContext';
import { MessageQueueProvider } from '../messaging/MessageQueueContext';
import { QORTAL_APP_CONTEXT } from '../context/AppContext';
import {
  userInfoAtom,
  balanceAtom,
  reticulumLegacyThreadsEnabledAtom,
} from '../atoms/global';
import { subscribeToEvent, unsubscribeFromEvent } from '../utils/events';
import i18n from '../i18n/i18n';
import '../styles/index.css';
import './style.css';
import { connectPresence } from './presence';

function Chat() {
  const store = useStore();
  useEffect(() => connectPresence(store, (window as any).presence), [store]);
  const { t } = useTranslation(['reticulum', 'group', 'core']);
  const [groupId, setGroupId] = useState(configuration.groups[0]?.groupId || 0);
  const [notice, setNotice] = useState('');
  const [groups, setGroups] = useState(configuration.groups);
  const [authority, setAuthority] = useState({ groupId: 0, isAdmin: false });
  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<any[]>([]);
  useEffect(() => {
    const events = [
      'openDirectMessageInternal',
      'openPaymentInternal',
      'openUserLookupDrawer',
    ];
    const unavailable = () => setNotice(t('reticulum:nuqloud.unsupported'));
    for (const event of events) subscribeToEvent(event, unavailable);
    return () => {
      for (const event of events) unsubscribeFromEvent(event, unavailable);
    };
  }, [t]);
  useEffect(() => {
    let cancelled = false;
    setMembersOpen(false);
    setMembers([]);
    if (!groupId) return;
    void fetch(`${configuration.coreUrl}/groups/members/${groupId}?limit=0`)
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.members)) setMembers(data.members);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupId]);
  useEffect(() => {
    let cancelled = false;
    if (groupId)
      void rpc('getGroupCapabilities', [groupId])
        .then((next) => {
          if (!cancelled && next.groupId === groupId) setAuthority(next);
        })
        .catch(() => {
          if (!cancelled) setNotice(t('reticulum:nuqloud.request_failed'));
        });
    return () => {
      cancelled = true;
    };
  }, [groupId, t]);
  useEffect(() => {
    let cancelled = false;
    void fetch(
      `${configuration.coreUrl}/groups/member/${encodeURIComponent(configuration.account.address)}`
    )
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const names = new Map(
          data.map((item) => [Number(item.groupId), item.groupName])
        );
        setGroups(
          configuration.groups.map((group) => ({
            ...group,
            groupName:
              typeof names.get(group.groupId) === 'string'
                ? names.get(group.groupId)
                : group.groupName,
          }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(
    () =>
      onChatEvent('onConnectionError', () =>
        setNotice(t('reticulum:nuqloud.request_failed'))
      ),
    [t]
  );
  useEffect(() => {
    const expiry = setTimeout(
      invalidateChat,
      Math.max(0, configuration.expiresAt - Date.now())
    );
    return () => clearTimeout(expiry);
  }, []);
  const group = groups.find((item) => item.groupId === groupId);
  const context = {
    onCancel: () => {},
    onOk: () => {},
    show: async (data: unknown) => parentRequest('confirm', data),
    showInfo: () => {},
    downloadResource: Object.assign(async () => {}, {
      cancelAllResourceDownloads: () => {},
      cancelResourceDownload: () => {},
    }),
    getIndividualUserInfo: async (address: string) => {
      const response = await fetch(
        `${configuration.coreUrl}/addresses/${encodeURIComponent(address)}`
      );
      return response.json();
    },
  };
  return (
    <QORTAL_APP_CONTEXT.Provider value={context as any}>
      <Box
        sx={{
          height: '100dvh',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography
            component="label"
            htmlFor="nuqloud-group"
            sx={{ display: { xs: 'none', sm: 'block' } }}
          >
            {t('reticulum:nuqloud.your_groups')}
          </Typography>
          <Select
            id="nuqloud-group"
            size="small"
            value={groupId || ''}
            disabled={!groups.length}
            onChange={(event) => setGroupId(Number(event.target.value))}
            inputProps={{ 'aria-label': t('reticulum:nuqloud.your_groups') }}
            sx={{ minWidth: 0, flex: 1, maxWidth: 480 }}
          >
            {groups.map((item) => (
              <MenuItem key={item.groupId} value={item.groupId}>
                {item.groupName || item.groupId}
              </MenuItem>
            ))}
          </Select>
          <Button
            size="small"
            onClick={() => {
              void parentRequest('directory').catch(() =>
                setNotice(t('reticulum:nuqloud.request_failed'))
              );
            }}
          >
            {t('group:find_groups.title')}
          </Button>
        </Box>
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {group ? (
            <ChatGroup
              key={`${configuration.context}:${groupId}`}
              selectedGroup={String(groupId)}
              selectedGroupName={group.groupName}
              myAddress={configuration.account.address}
              secretKey={null}
              getSecretKey={async () => null}
              adminsWithNames={[]}
              isReticulumChannelAdmin={
                authority.groupId === groupId && authority.isAdmin
              }
              reticulumChannelAccessReady={authority.groupId === groupId}
              handleNewEncryptionNotification={() => {}}
              hide={false}
              hideView={false}
              handleSecretKeyCreationInProgress={() => {}}
              triedToFetchSecretKey={false}
              getTimestampEnterChatParent={() => {}}
              isActive={true}
              isPrivate={false}
              groupCallDisabled={true}
              groupCallTooltip={t('reticulum:nuqloud.unsupported')}
              onMembersClick={() => setMembersOpen(true)}
              membersPanelOpen={membersOpen}
              embeddedCapabilities={{
                calendar: false,
                resources: true,
                manager: false,
                autoWelcome: false,
              }}
            />
          ) : (
            <Typography sx={{ p: 3 }}>
              {t('reticulum:nuqloud.no_groups')}
            </Typography>
          )}
        </Box>
      </Box>
      <Snackbar
        open={!!notice}
        autoHideDuration={6000}
        onClose={() => setNotice('')}
        message={notice}
      />
      <Dialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('group:member_category.members')}</DialogTitle>
        <DialogContent>
          <List>
            {members.map((member) => (
              <ListItem key={member.member}>
                <ListItemText
                  primary={member.member}
                  secondary={
                    member.isAdmin ? t('core:admin', { count: 1 }) : undefined
                  }
                  primaryTypographyProps={{ sx: { overflowWrap: 'anywhere' } }}
                />
              </ListItem>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMembersOpen(false)}>
            {t('core:action.close', { postProcess: 'capitalizeFirstChar' })}
          </Button>
        </DialogActions>
      </Dialog>
    </QORTAL_APP_CONTEXT.Provider>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <Typography sx={{ p: 3 }}>{i18n.t('reticulum:nuqloud.waiting')}</Typography>
);
initializeBridge(() =>
  root.render(
    <Typography sx={{ p: 3 }}>
      {i18n.t('reticulum:nuqloud.session_ended')}
    </Typography>
  )
)
  .then((config) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href
      );
      if (url.href.startsWith(`${config.coreUrl}/`)) {
        const headers = new Headers(options.headers);
        if (!['GET', 'HEAD'].includes(options.method || 'GET'))
          headers.set('requesttoken', config.requestToken);
        options = { ...options, headers, credentials: 'same-origin' };
      }
      return originalFetch(input, options);
    };
    const store = createStore();
    store.set(userInfoAtom, config.account);
    store.set(balanceAtom, 0);
    store.set(reticulumLegacyThreadsEnabledAtom, false);
    localStorage.setItem(
      'saved_ui_theme',
      JSON.stringify({ mode: config.theme, currentThemeId: 'default' })
    );
    root.render(
      <Provider store={store}>
        <ThemeProvider>
          <CssBaseline />
          <MessageQueueProvider maxRetries={0}>
            <Chat />
          </MessageQueueProvider>
        </ThemeProvider>
      </Provider>
    );
  })
  .catch(() =>
    root.render(
      <Typography sx={{ p: 3 }}>
        {i18n.t('reticulum:nuqloud.request_failed')}
      </Typography>
    )
  );
