import { expect, test } from 'vitest';
import { isReadyGreeting } from './hosts.ts';

test('the two greetings RFC 9051 §7.1.1 says mean ready', () => {
  expect(isReadyGreeting('* OK [CAPABILITY IMAP4rev1] Dovecot ready.')).toBe(true);
  expect(isReadyGreeting('* PREAUTH IMAP4rev1 server logged in as user')).toBe(true);
});

test('everything else fails the host', () => {
  expect(isReadyGreeting('* BYE Too many connections from this IP')).toBe(false);
  expect(isReadyGreeting('220 smtp.example.com ESMTP')).toBe(false);
  expect(isReadyGreeting('')).toBe(false);
  // A greeting is a whole line from the start.
  expect(isReadyGreeting('* BYE OK never mind')).toBe(false);
});
