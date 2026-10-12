import { PASSKEY_NAME_MAX_LENGTH } from '@yozz.app/vault-contract';
import { describe, expect, it } from 'vitest';
import { automaticPasskeyName, normalizePasskeyName } from './passkey-name';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  firefoxWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 OPR/120.0.0.0',
};

describe('automaticPasskeyName', () => {
  it.each([
    ['Chrome on Mac', UA.chromeMac],
    ['Safari on iPhone', UA.safariIphone],
    ['Safari on Mac', UA.safariMac],
    ['Firefox on Windows', UA.firefoxWindows],
    ['Edge on Windows', UA.edgeWindows],
    ['Chrome on Android', UA.chromeAndroid],
    ['Chrome on iPhone', UA.chromeIphone],
    ['Firefox on Linux', UA.firefoxLinux],
    ['Opera on Windows', UA.operaWindows],
  ])('reads %s from the user agent', (name, userAgent) => {
    expect(automaticPasskeyName({ userAgent })).toBe(name);
  });

  it('prefers what userAgentData says where it says anything', () => {
    expect(
      automaticPasskeyName({
        userAgent: UA.chromeMac,
        userAgentData: {
          platform: 'Windows',
          brands: [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }, { brand: 'Microsoft Edge' }],
        },
      }),
    ).toBe('Edge on Windows');
  });

  it('falls back to the user agent for what userAgentData leaves out', () => {
    expect(
      automaticPasskeyName({
        userAgent: UA.chromeMac,
        userAgentData: { platform: '', brands: [{ brand: 'Chromium' }] },
      }),
    ).toBe('Chrome on Mac');
  });

  it('names one half when the other is unknown, and falls back to Passkey for neither', () => {
    expect(automaticPasskeyName({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/1' })).toBe(
      'Windows',
    );
    expect(automaticPasskeyName({ userAgent: 'Firefox/140.0' })).toBe('Firefox');
    expect(automaticPasskeyName({ userAgent: '' })).toBe('Passkey');
  });
});

describe('normalizePasskeyName', () => {
  it('trims, and caps at the length the Worker accepts', () => {
    expect(normalizePasskeyName('  Work laptop \n')).toBe('Work laptop');
    expect(normalizePasskeyName('x'.repeat(PASSKEY_NAME_MAX_LENGTH + 20))).toBe(
      'x'.repeat(PASSKEY_NAME_MAX_LENGTH),
    );
  });

  it('answers empty for a name of nothing but space', () => {
    expect(normalizePasskeyName('   ')).toBe('');
  });
});
