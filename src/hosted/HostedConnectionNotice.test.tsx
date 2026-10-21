import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HostedRequestError, isHostedRequestError } from './errors';
import { HostedConnectionNotice } from './HostedConnectionNotice';

const { client, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value: any) => void>>();
  return {
    listeners,
    client: {
      state: 'connected',
      on(channel: string, listener: (value: any) => void) {
        const callbacks = listeners.get(channel) ?? new Set();
        callbacks.add(listener);
        listeners.set(channel, callbacks);
        return () => callbacks.delete(listener);
      },
    },
  };
});
vi.mock('./bootstrap', () => ({ hostedClient: client }));
vi.mock('../i18n/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function emit(channel: string, value: unknown) {
  act(() => listeners.get(channel)?.forEach((listener) => listener(value)));
}

beforeEach(() => {
  listeners.clear();
  client.state = 'connected';
});

it('shows a dismissible request failure beside the still-mounted application', () => {
  render(
    <>
      <div>Authenticated wallet</div>
      <HostedConnectionNotice />
    </>
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  emit('request-error', new HostedRequestError('operation'));
  expect(screen.getByRole('alert')).toHaveTextContent(
    'reticulum:hosted.request_failed'
  );
  expect(screen.getByText('Authenticated wallet')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'core:action.close' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('reports reconnecting separately and removes the notice after recovery', () => {
  const { unmount } = render(<HostedConnectionNotice />);
  emit('state', 'disconnected');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'reticulum:hosted.reconnecting'
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  emit('state', 'connected');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();
  expect(
    [...listeners.values()].every((callbacks) => callbacks.size === 0)
  ).toBe(true);
});

it('classifies only typed hosted failures as non-fatal, independently of translated message text', () => {
  const error = new HostedRequestError('busy', 'reticulumChat:getHistory');
  expect(isHostedRequestError(error)).toBe(true);
  expect(isHostedRequestError(new Error(error.message))).toBe(false);
  expect(
    isHostedRequestError(new TypeError('unexpected programming fault'))
  ).toBe(false);
});
