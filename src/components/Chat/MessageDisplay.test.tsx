// MessageDisplay.test.ts
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { extractComponents, MessageDisplay } from './MessageDisplay';

describe('extractComponents', () => {
  // sanity checks
  it('returns null for falsy or non-qortal URLs', () => {
    expect(extractComponents('')).toBeNull();
    expect(extractComponents(null as unknown as string)).toBeNull();
    expect(extractComponents('https://example.com')).toBeNull();
  });

  it('returns null for qortal://use-* links', () => {
    expect(extractComponents('qortal://use-tool')).toBeNull();
    expect(extractComponents('qortal://use-')).toBeNull();
  });

  it('parses service-based URLs with a slash', () => {
    const res = extractComponents('qortal://blog/alice/my-post');
    expect(res).toEqual({
      service: 'BLOG',
      name: 'alice',
      identifier: undefined,
      path: 'my-post',
    });
  });

  it('defaults qortal://<username> to WEBSITE service', () => {
    const res = extractComponents('qortal://alice');
    expect(res).toEqual({
      service: 'WEBSITE',
      name: 'alice',
      identifier: undefined,
      path: '',
    });
  });

  it('leaves explicit WEBSITE service intact', () => {
    const res = extractComponents('qortal://WEBSITE/bob');
    expect(res).toEqual({
      service: 'WEBSITE',
      name: 'bob',
      identifier: undefined,
      path: '',
    });
  });

  it('uppercases the service portion only', () => {
    const res = extractComponents('qortal://weBsiTe/CaseUser');
    expect(res).toEqual({
      service: 'WEBSITE',
      name: 'CaseUser',
      identifier: undefined,
      path: '',
    });
  });

  // a couple of edge cases
  it('handles just protocol (no content) as null', () => {
    expect(extractComponents('qortal://')).toBeNull();
  });
  it('preserves escaped names/routes, nested query values and fragments', () => {
    expect(
      extractComponents(
        'qortal://APP/Alice%2520Name/path%2Fkeep?next=%252F#section'
      )
    ).toEqual({
      service: 'APP',
      name: 'Alice%20Name',
      identifier: undefined,
      path: 'path%2Fkeep?next=%252F#section',
    });
    expect(extractComponents('qortal://alice?next=%2F#section')).toEqual({
      service: 'WEBSITE',
      name: 'alice',
      identifier: undefined,
      path: '?next=%2F#section',
    });
    expect(
      extractComponents(
        'qortal://APP/Alice/route?identifier=id%252F&next=%2F#part'
      )
    ).toEqual({
      service: 'APP',
      name: 'Alice',
      identifier: 'id%2F',
      path: 'route?next=%2F#part',
    });
  });

  it('handles single-segment non-empty after protocol with spaces', () => {
    const res = extractComponents(
      'qortal://  alice  '.replace('  ', '').replace('  ', '')
    ); // simulate trimmed input
    expect(res).toEqual({
      service: 'WEBSITE',
      name: 'alice',
      identifier: undefined,
      path: '',
    });
  });
});

describe('message link activation', () => {
  it('opens a web link when a nested formatted label is clicked', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const { getByText } = render(
        <MessageDisplay htmlContent='<p><a href="https://example.com/path"><strong>External link label</strong></a></p>' />
      );
      fireEvent.click(getByText('External link label'));
      expect(open).toHaveBeenCalledWith(
        'https://example.com/path',
        '_blank',
        'noopener,noreferrer'
      );
    } finally {
      open.mockRestore();
    }
  });
});

describe('Reticulum privileged mention rendering', () => {
  const everyoneHtml =
    '<p><span class="mention" data-type="mention" data-id="everyone" data-label="everyone">@everyone</span></p>';

  it('renders an unauthorized broadcast token as ordinary text', () => {
    const { container } = render(
      <MessageDisplay
        htmlContent={everyoneHtml}
        privilegedMentionAuthorized={false}
      />
    );

    expect(container.textContent).toContain('@everyone');
    expect(container.querySelector('.mention')).toBeNull();
  });

  it('removes spoofed styling even when a modified sender omits the mention id', () => {
    const { container } = render(
      <MessageDisplay
        htmlContent={
          '<p><span class="mention" data-label="here">@here</span></p>'
        }
        privilegedMentionAuthorized={false}
      />
    );

    expect(container.textContent).toContain('@here');
    expect(container.querySelector('.mention')).toBeNull();
  });

  it('removes spoofed styling when a modified sender supplies a different id', () => {
    const { container } = render(
      <MessageDisplay
        htmlContent={
          '<p><span class="mention" data-type="mention" data-id="ordinary-user">@everyone</span></p>'
        }
        privilegedMentionAuthorized={false}
      />
    );

    expect(container.textContent).toContain('@everyone');
    expect(container.querySelector('.mention')).toBeNull();
  });

  it('preserves mention styling after local authorization', () => {
    const { container } = render(
      <MessageDisplay htmlContent={everyoneHtml} privilegedMentionAuthorized />
    );

    expect(container.querySelector('.mention')?.textContent).toBe('everyone');
  });

  it('renders an authorized label-only mention without the trigger character', () => {
    const { container } = render(
      <MessageDisplay
        htmlContent={
          '<p><span class="mention" data-label="here">@here</span></p>'
        }
        privilegedMentionAuthorized
      />
    );

    expect(container.querySelector('.mention')?.textContent).toBe('here');
  });
});
