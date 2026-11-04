// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildMailFrame } from '@yozz.app/mail/threads/html';
import { expect, it } from 'vitest';

it('keeps the host CSP hash aligned with the exact script in the frame', () => {
  const { srcdoc } = buildMailFrame('<p>x</p>', { allowRemoteImages: false, isReadOnly: false });
  const script = srcdoc.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (script === undefined) throw new Error('frame script not found');
  const hash = createHash('sha256').update(script).digest('base64');
  expect(readFileSync('public/_headers', 'utf8')).toContain(`'sha256-${hash}'`);
});
