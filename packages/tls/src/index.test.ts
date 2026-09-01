import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as tls from './index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('public export allowlist & encapsulation guards', () => {
  it('exports only the approved public runtime symbols', () => {
    const exportedSymbols = Object.keys(tls).toSorted();
    const expectedSymbols = [
      'CIPHER_SUITES',
      'NAMED_GROUPS',
      'namedGroupFromCode',
      'SIGNATURE_SCHEMES',
      'signatureSchemeFromCode',
      'SUPPORTED_GROUPS',
      'SUPPORTED_SIGNATURE_SCHEMES',
      'deriveSecret',
      'earlySecret',
      'finishedKey',
      'handshakeSecret',
      'hkdfExpandLabel',
      'hkdfExtract',
      'isVerifyDataValid',
      'masterSecret',
      'pinnedValidator',
      'publicKeyPin',
      'startTls',
      'trafficKeys',
      'transcriptHash',
      'verifyData',
    ].toSorted();

    expect(exportedSymbols).toEqual(expectedSymbols);
  });

  it('no non-test file under src/ imports replay.ts', () => {
    const srcDir = __dirname;
    const files = readdirSync(srcDir, { recursive: true })
      .map(f => String(f))
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'replay.ts');

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf8');
      expect(content).not.toMatch(/from\s+['"][^'"]*replay(?:\.ts)?['"]/);
      expect(content).not.toMatch(/import\s*\(\s*['"][^'"]*replay(?:\.ts)?['"]\s*\)/);
    }
  });

  /** `runHandshake` takes the injection hooks directly; only `replay.ts` may name it. */
  it('only replay.ts imports runHandshake', () => {
    const callers = readdirSync(__dirname, { recursive: true })
      .map(entry => String(entry))
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'replay.ts')
      .filter(file => /\brunHandshake\b/.test(readFileSync(join(__dirname, file), 'utf8')));

    expect(callers).toEqual(['handshake.ts']);
  });
});
