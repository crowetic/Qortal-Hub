import { describe, expect, it } from 'vitest';
import { pirateWalletResult } from './pirate-wallet-response';

describe('Pirate Core wallet error contract', () => {
  it.each([false, true])(
    'preserves Core errors regardless of HTTP success (%s)',
    (httpOk) => {
      expect(() =>
        pirateWalletResult(
          {
            error: 1205,
            message:
              'ERR_RESCAN_REQUIRED: Wallet requires a full rescan before spending.',
          },
          httpOk,
          'fallback'
        )
      ).toThrow(
        'ERR_RESCAN_REQUIRED: Wallet requires a full rescan before spending.'
      );
    }
  );
  it('preserves a plain failure reason', () => {
    expect(() => pirateWalletResult('Wallet busy', false, 'fallback')).toThrow(
      'Wallet busy'
    );
  });
  it('passes successful sync and transaction results through unchanged', () => {
    expect(pirateWalletResult('Synchronized', true, 'fallback')).toBe(
      'Synchronized'
    );
    const txId = 'ab'.repeat(32);
    expect(pirateWalletResult(txId, true, 'fallback')).toBe(txId);
  });
  it.each([
    null,
    '<html>upstream failed</html>',
    { error: 500 },
    { error: 500, entropy58: 'secret-test-only' },
  ])('uses the translated fallback for unreadable failures', (body) => {
    expect(() =>
      pirateWalletResult(body, false, 'translated fallback')
    ).toThrow('translated fallback');
  });
  it('bounds and redacts diagnostic strings instead of returning request credentials', () => {
    expect(() =>
      pirateWalletResult(
        { error: 1205, message: 'Failed?apiKey=secret-test-key' },
        false,
        'fallback'
      )
    ).toThrow('Failed?apiKey=…');
    try {
      pirateWalletResult('a'.repeat(10000), false, 'fallback');
    } catch (error) {
      expect((error as Error).message).toHaveLength(1000);
    }
  });
});
