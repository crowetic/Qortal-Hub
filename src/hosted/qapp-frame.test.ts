import { expect, it } from 'vitest';
import { hostedQappOrigin, isHostedQappMessage } from './qapp-frame';
import { buildAppRenderRoot } from '../components/Apps/appRenderUrl';

it('keeps encoded Q-App names on the expected hosted frame origin', () => {
  const frame = document.createElement('iframe');
  frame.src = buildAppRenderRoot('https://qdn.test', 'APP', 'alice + bob?#');
  document.body.append(frame);
  expect(frame.src).toBe('https://qdn.test/render/APP/alice%20%2B%20bob%3F%23');
  const event = {
    source: frame.contentWindow,
    origin: 'https://qdn.test',
    data: { action: 'RNS_CONNECT' },
    ports: [{}],
  } as unknown as MessageEvent;
  expect(isHostedQappMessage(event, frame, 'https://hub.test')).toBe(true);
  expect(
    isHostedQappMessage(
      { ...event, origin: 'https://evil.test' } as MessageEvent,
      frame,
      'https://hub.test'
    )
  ).toBe(false);
  frame.remove();
});

it('accepts only the expected Q-App frame and a separate HTTP origin', () => {
  const frame = document.createElement('iframe');
  frame.src = 'https://qdn.test/render/APP/example';
  document.body.append(frame);
  const event = {
    source: frame.contentWindow,
    origin: 'https://qdn.test',
    data: { action: 'RNS_CONNECT' },
    ports: [{}],
  } as unknown as MessageEvent;
  expect(isHostedQappMessage(event, frame, 'https://hub.test')).toBe(true);
  expect(
    isHostedQappMessage(
      { ...event, source: window } as MessageEvent,
      frame,
      'https://hub.test'
    )
  ).toBe(false);
  expect(
    isHostedQappMessage(
      { ...event, origin: 'https://evil.test' } as MessageEvent,
      frame,
      'https://hub.test'
    )
  ).toBe(false);
  expect(isHostedQappMessage(event, frame, 'https://qdn.test')).toBe(false);
  expect(hostedQappOrigin('javascript:alert(1)', 'https://hub.test')).toBe(
    null
  );
  frame.remove();
});
