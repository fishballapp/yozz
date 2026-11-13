/**
 * Whether this browser is signed in to YOZZ, as `yozz.app/` needs to know it: the landing page
 * for a visitor, the app for someone who uses it. Exported to the yozz-web Worker, which reads
 * the cookie, and to the landing page, which reads the device database (DECISIONS.md, "The
 * landing page at /, and who skips it").
 *
 * The cookie is a hint, never a credential: it holds no identity, and a forged one only serves
 * the app's shell, which asks for a login like any other path.
 */
export const SIGNED_IN_COOKIE = 'yozz-signed-in';

// 400 days, the most a browser keeps a cookie; every unlock writes it again.
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** Set while a vault session is open on this device; cleared when it is locked. */
export const rememberSignedIn = (doc: Document): void => {
  doc.cookie = `${SIGNED_IN_COOKIE}=1; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
};

export const forgetSignedIn = (doc: Document): void => {
  doc.cookie = `${SIGNED_IN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
};

/** Reads a `Cookie` request header. */
export const isSignedInCookieSet = (cookieHeader: string | null): boolean =>
  (cookieHeader ?? '').split(';').some(pair => pair.trim() === `${SIGNED_IN_COOKIE}=1`);

// The device's own answer, for a browser with no cookie: unlock keys saved here mean someone signed
// in and has not signed out. A device that unlocked before the cookie existed has the keys alone.
export { hasAnyUnlockKeys } from './unlock-keys';
