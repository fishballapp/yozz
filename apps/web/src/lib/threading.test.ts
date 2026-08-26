import { describe, expect, it } from 'vitest';
import { baseSubject, groupIntoThreads, type ThreadableMessage } from './threading';

const msg = (
  uid: number,
  over: Partial<Omit<ThreadableMessage, 'id'>> = {},
): ThreadableMessage => ({
  id: `m${uid}`,
  messageId: `<m${uid}@x>`,
  inReplyTo: null,
  references: [],
  subject: 'Lunch',
  gmailThreadId: null,
  ...over,
});

describe('baseSubject', () => {
  it('strips the RFC prefixes, the localized ones, list tags and fwd wrappers, repeatedly', () => {
    expect(baseSubject('Re: ODP: FW: WG: Re: AW: Original Subject')).toBe('original subject');
    expect(baseSubject('[dev] Re: [dev]   Deploy   plan')).toBe('deploy plan');
    expect(baseSubject('[Fwd: Re: Invoice] ')).toBe('invoice');
    expect(baseSubject('Re[2]: hello (fwd)')).toBe('hello');
    expect(baseSubject('回复: 午餐')).toBe('午餐');
    expect(baseSubject(null)).toBe('');
  });
  it('keeps a subject that is only a list tag', () => {
    expect(baseSubject('[announce]')).toBe('[announce]');
  });
});

describe('groupIntoThreads', () => {
  it('joins a reply to its parent through In-Reply-To or References, keyed by the first in input order', () => {
    const groups = groupIntoThreads([
      msg(10),
      msg(12, { subject: 'Re: Lunch', inReplyTo: '<m10@x>' }),
      msg(15, { subject: 'RE: lunch', references: ['<m10@x>', '<m12@x>'] }),
      msg(11, { subject: 'Other' }),
    ]);
    expect([...groups.entries()]).toEqual([
      ['m10', ['m10', 'm12', 'm15']],
      ['m11', ['m11']],
    ]);
  });

  it('does not join a shared id under a different base subject (thread hijack)', () => {
    const groups = groupIntoThreads([
      msg(1),
      msg(2, { subject: 'New topic', inReplyTo: '<m1@x>' }),
    ]);
    expect(groups.size).toBe(2);
  });

  it('trusts Gmail ids where they exist, whatever the headers say', () => {
    const groups = groupIntoThreads([
      msg(1, { gmailThreadId: '7' }),
      msg(2, { gmailThreadId: '7', subject: 'Unrelated', inReplyTo: null }),
      msg(3, { gmailThreadId: '8', subject: 'Re: Lunch', inReplyTo: '<m1@x>' }),
    ]);
    expect([...groups.entries()]).toEqual([
      ['m1', ['m1', 'm2']],
      ['m3', ['m3']],
    ]);
  });

  it('joins through any parent when In-Reply-To carries several ids with CFWS', () => {
    const groups = groupIntoThreads([
      msg(1),
      msg(5),
      msg(9, { subject: 'Re: Lunch', inReplyTo: '<m1@x> <m5@x>' }),
    ]);
    expect(groups.get('m1')).toEqual(['m1', 'm5', 'm9']);
  });

  it('names a group by the earliest member even when a later link joins an earlier one', () => {
    // m3 joins m1 only through m5, and m5 was linked to m3 first; the root must still be m1.
    const groups = groupIntoThreads([
      msg(1),
      msg(3, { inReplyTo: '<m5@x>' }),
      msg(5, { inReplyTo: '<m1@x>' }),
    ]);
    expect([...groups.entries()]).toEqual([['m1', ['m1', 'm3', 'm5']]]);
  });

  it('a message with no ids at all stands alone', () => {
    const groups = groupIntoThreads([msg(1, { messageId: null }), msg(2, { messageId: null })]);
    expect(groups.size).toBe(2);
  });
});
