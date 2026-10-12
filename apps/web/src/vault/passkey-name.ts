import { PASSKEY_NAME_MAX_LENGTH } from '@yozz.app/vault-contract';

/** What `navigator` offers a name is made from; `userAgentData` is Chromium's, absent elsewhere. */
export type NameEnvironment = {
  readonly userAgent: string;
  readonly userAgentData?: {
    readonly platform?: string;
    readonly brands?: readonly { readonly brand: string }[];
  };
};

/** `Chromium` and the GREASE brand are what every Chromium browser says; the first other brand is the product. */
const BRANDS: Readonly<Record<string, string>> = {
  'Google Chrome': 'Chrome',
  'Microsoft Edge': 'Edge',
  Opera: 'Opera',
  Brave: 'Brave',
  Vivaldi: 'Vivaldi',
};

/** Order matters: Edge, Opera and Chrome on iOS all say `Chrome` or `Safari` too. */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/** iPhone and iPad before Mac, which iPadOS also claims; Android before Linux, which it also claims. */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const PLATFORMS: Readonly<Record<string, string>> = {
  macOS: 'Mac',
  Windows: 'Windows',
  Android: 'Android',
  Linux: 'Linux',
  'Chrome OS': 'ChromeOS',
};

const firstMatch = (table: readonly (readonly [RegExp, string])[], text: string) =>
  table.find(([pattern]) => pattern.test(text))?.[1];

/**
 * The browser and system this is running in, as a name a person recognises on another device:
 * "Chrome on Mac", "Safari on iPhone". A small parse rather than a library, and a guess: the user
 * agent is frozen in Chromium and names no model, so it says which kind of device, not which one.
 */
export const automaticPasskeyName = ({
  userAgent,
  userAgentData,
}: NameEnvironment = navigator): string => {
  const brand = userAgentData?.brands?.map(({ brand }) => BRANDS[brand]).find(Boolean);
  const browser = brand ?? firstMatch(BROWSERS, userAgent);
  const system =
    (userAgentData?.platform === undefined ? undefined : PLATFORMS[userAgentData.platform]) ??
    firstMatch(SYSTEMS, userAgent);
  if (browser !== undefined && system !== undefined) return `${browser} on ${system}`;
  return browser ?? system ?? 'Passkey';
};

/** A typed name, trimmed and held to the length the Worker accepts; empty is the caller's to refuse or replace. */
export const normalizePasskeyName = (typed: string): string =>
  typed.trim().slice(0, PASSKEY_NAME_MAX_LENGTH).trim();
