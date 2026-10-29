import { describe, expect, it } from 'vitest';
import { qortalAppLink } from './links';

describe('NuQloud QDN viewer links', () => {
  it('encodes the resource name once and preserves route/query/fragment data', () => {
    expect(
      qortalAppLink({
        service: 'APP',
        name: 'Alice%20Name',
        path: '/path%2Fkeep?next=%252F#part',
      })
    ).toBe('qortal://APP/Alice%2520Name/path%2Fkeep?next=%252F#part');
    expect(
      qortalAppLink({
        service: 'WEBSITE',
        name: 'Example',
        path: '?next=%2F#part',
        identifier: 'id%2F',
      })
    ).toBe('qortal://WEBSITE/Example/?next=%2F&identifier=id%252F#part');
  });
  it('rejects unsupported protocols, missing names and control characters', () => {
    for (const data of [
      null,
      {},
      { service: 'javascript', name: 'alert(1)' },
      { service: 'APP', name: '' },
      { service: 'APP', name: 'App', path: 'bad\npath' },
    ])
      expect(qortalAppLink(data)).toBeNull();
  });
});
