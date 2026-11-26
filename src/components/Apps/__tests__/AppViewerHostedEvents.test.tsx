import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../../App', () => ({
  getBaseApiReact: () => 'https://core.example',
}));
vi.mock('../../../qortal/get', () => ({ saveFile: vi.fn() }));
vi.mock('../../Theme/ThemeContext', () => ({
  useThemeContext: () => ({ themeMode: 'dark' }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }),
}));

// Keep the real hook: AppViewer initially has no URL or iframe. A hook mock
// would hide whether the subscription survives that first render.
import { AppViewer } from '../AppViewer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('forwards owner-scoped hosted events after the iframe mounts asynchronously', async () => {
  const listeners = new Map<string, (payload: any) => void>();
  const off = vi.fn();
  const subscribe = (channel: string) =>
    vi.fn((listener) => {
      listeners.set(channel, listener);
      return off;
    });
  vi.stubGlobal('hubHosted', true);
  vi.stubGlobal('electronAPI', {
    onQAppReticulumEvent: subscribe('rns'),
    onPrivateChannelEvent: subscribe('private'),
    onQAppMoqEvent: subscribe('moq'),
    qappGuestRelease: vi.fn().mockResolvedValue(true),
  });
  const app = { tabId: 'hotel', name: 'Hotel-Demo', service: 'WEBSITE' };
  const { container, unmount } = render(
    <AppViewer app={app} isDevMode={false} />
  );
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  await waitFor(() => expect(listeners.has('rns')).toBe(true));
  const frame = container.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const reply = {
    ownerKey: 'hotel\u0000WEBSITE\u0000hotel-demo',
    connectionId: 'logical-hotel',
    action: 'RNS_MESSAGE',
    payload: { type: 'INC_WELCOME' },
  };
  act(() => listeners.get('rns')!({ ...reply, ownerKey: 'other-tab' }));
  expect(post).not.toHaveBeenCalled();
  act(() => listeners.get('rns')!(reply));
  expect(post).toHaveBeenLastCalledWith(
    {
      action: reply.action,
      connectionId: reply.connectionId,
      payload: reply.payload,
      requestedHandler: 'UI',
    },
    'https://core.example'
  );
  act(() =>
    listeners.get('private')!({
      ...reply,
      action: 'PRIVATE_CHANNEL_STATE',
      channelId: 'private-1',
      state: 'OPEN',
    })
  );
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({ channelId: 'private-1', state: 'OPEN' }),
    'https://core.example'
  );
  act(() =>
    listeners.get('moq')!({
      ...reply,
      action: 'MOQ_STATE',
      sessionId: 'moq-1',
      state: 'OPEN',
    })
  );
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'moq-1', state: 'OPEN' }),
    'https://core.example'
  );
  // Resolve the live iframe origin at delivery, retaining the shell-origin
  // exclusion even when its src changes without changing the owning tab.
  frame.src = `${location.origin}/unexpected-shell-frame`;
  const shellPost = vi.spyOn(frame.contentWindow!, 'postMessage');
  act(() => listeners.get('rns')!(reply));
  expect(shellPost).not.toHaveBeenCalled();
  frame.src = 'https://other-core.example/render/WEBSITE/Hotel-Demo';
  const movedPost = vi.spyOn(frame.contentWindow!, 'postMessage');
  act(() => listeners.get('rns')!(reply));
  expect(movedPost).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'RNS_MESSAGE' }),
    'https://other-core.example'
  );
  post.mockClear();
  unmount();
  expect(off).toHaveBeenCalledTimes(3);
  act(() => listeners.get('rns')!(reply));
  expect(post).not.toHaveBeenCalled();
});
