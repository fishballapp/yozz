/**
 * `isReadyGreeting` decides whether a live host passes M8, so the case that
 * must be REFUSED is the one worth a test: `* BYE` decrypts perfectly, proves
 * the keys work, and still means the server turned us away.
 *
 * The gate used to print the greeting beside a pass and count the handshake
 * alone, which is how a client that completed a handshake and then failed to
 * decrypt the first record would have exited 0.
 */
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
  // A greeting is a whole line from the start; `OK` further in is not one.
  expect(isReadyGreeting('* BYE OK never mind')).toBe(false);
});
