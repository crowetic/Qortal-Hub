import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { decryptGroupDataQortalRequest } from '../../../src/qdn/encryption/group-encryption';

vi.mock('../../../src/i18n/i18n', () => ({
  default: { t: (key: string) => key },
}));

// Opt-in companion check: use built Auth's real first-key publisher and Hub's
// unchanged native decryptor, rather than reproducing either wire format.
const authRoot = process.env.QORTAL_EXTERNAL_AUTH_REPO;
it.skipIf(!authRoot)(
  'decrypts Auth-created member/admin keys with the native Hub reader',
  async () => {
    const require = createRequire(path.join(authRoot!, 'package.json'));
    const {
      createGroupSecretKey,
    } = require('./packages/auth-daemon/dist/groupKeys.js');
    const {
      Base58,
      nacl,
      publicKeyToAddress,
    } = require('./packages/auth-core/dist/index.js');
    const pairs = [31, 32, 33].map((value) =>
      nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(value))
    );
    const addresses = pairs.map((pair) => publicKeyToAddress(pair.publicKey));
    const wallet = {
      id: 'interop-admin',
      address0: addresses[0],
      publicKey: Base58.encode(pairs[0].publicKey),
    };
    for (const isOpen of [false, true]) {
      for (const isAdmins of isOpen ? [true] : [false, true]) {
        let encrypted: string;
        await createGroupSecretKey(
          {
            walletId: wallet.id,
            groupId: 1197,
            feeAtomic: '1000000',
            isAdmins,
          },
          wallet,
          {
            read: async (resource: string) => {
              if (resource === '/groups/1197')
                return { groupId: 1197, owner: wallet.address0, isOpen };
              if (resource.startsWith('/groups/members/'))
                return {
                  memberCount: 2,
                  adminCount: 1,
                  members: [
                    { member: addresses[0], isAdmin: true },
                    { member: addresses[1] },
                  ],
                };
              if (resource === '/admin/status')
                return { isSynchronizing: false, syncPercent: 100, height: 10 };
              if (resource === '/blocks/byheight/1')
                return { signature: 'interop-chain' };
              if (resource.startsWith('/names/primary/'))
                return { name: 'interop-admin' };
              if (resource === '/names/interop-admin')
                return { owner: wallet.address0 };
              if (resource.startsWith('/arbitrary/resources/search?'))
                return [];
              if (resource.startsWith('/addresses/'))
                return {
                  publicKey: Base58.encode(
                    pairs[addresses.indexOf(resource.slice(11))].publicKey
                  ),
                };
              throw new Error('Unexpected fixture resource');
            },
            getSigningKey: async () => new Uint8Array(pairs[0].secretKey),
            reserve: async () => async () => {},
            publish: async (resource: any) => {
              encrypted = resource.data;
              return { signature: Base58.encode(new Uint8Array(64).fill(4)) };
            },
          }
        );
        const decode = (index: number) =>
          JSON.parse(
            Buffer.from(
              decryptGroupDataQortalRequest(
                encrypted!,
                Base58.encode(pairs[index].secretKey)
              )
            ).toString()
          );
        const key = decode(0);
        expect(Object.keys(key)).toEqual(['1']);
        expect(Buffer.from(key['1'].messageKey, 'base64')).toHaveLength(32);
        if (isAdmins) expect(() => decode(1)).toThrow();
        else expect(decode(1)).toEqual(key);
        expect(() => decode(2)).toThrow();
      }
    }
  }
);
