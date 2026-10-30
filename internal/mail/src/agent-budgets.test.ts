import { describe, expect, it } from 'vitest';
import { clip } from './agent-budgets.ts';

describe('clip', () => {
  it('cuts to the budget and says how much went', () => {
    expect(clip('abcdef', 4)).toBe('abcd…[truncated 2 chars]');
    expect(clip('abc', 4)).toBe('abc');
  });

  it('never keeps half of a surrogate pair', () => {
    // Two code units each: three units end inside the second.
    const emoji = '\u{1F600}'.repeat(3);
    const cut = clip(emoji, 3);
    expect(cut).toBe(`${'\u{1F600}'}…[truncated 4 chars]`);
    expect(new TextDecoder().decode(new TextEncoder().encode(cut))).toBe(cut);
  });
});
