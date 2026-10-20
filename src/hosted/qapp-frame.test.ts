import { expect, it } from 'vitest';
import { hostedQappOrigin, isHostedQappMessage } from './qapp-frame';

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
