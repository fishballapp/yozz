// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ReaderRest } from './ReaderRest';

const host = document.createElement('div');
const root = createRoot(host);

afterEach(async () => {
  await act(async () => root.render(null));
});

describe('the reader with nothing open', () => {
  it('shows nothing: the list beside it says what it holds and carries the one button', async () => {
    await act(async () => root.render(<ReaderRest />));
    expect(host.textContent).toBe('');
    expect(host.querySelector('a, button')).toBeNull();
  });
});
