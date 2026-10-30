import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Logger from 'effect/Logger';
import { afterAll, describe, expect, it } from 'vitest';
import { CliLayer } from './app.ts';

const home = mkdtempSync(join(tmpdir(), 'yozz-bin-'));
afterAll(() => rmSync(home, { recursive: true }));

/** The real bin, as a shell runs it, with no credentials. */
const yozz = (...args: string[]) =>
  spawnSync(process.execPath, [join(import.meta.dirname, 'bin.ts'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home },
  });

describe('the bin', () => {
  it.each([
    [['whoami'], 'NotLoggedIn'],
    [['read'], 'UsageError'],
    [['--bogus'], 'UsageError'],
    [['list', '--limit', '0', '--wait', '0', '--nope'], 'UsageError'],
  ])('yozz %j fails as one JSON line on stderr, nothing on stdout, and exit 1', (args, code) => {
    const { status, stdout, stderr } = yozz(...args);
    expect(status).toBe(1);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ error: { code } });
  });

  it('prints help on stdout when asked, and exits 0', () => {
    const { status, stdout, stderr } = yozz('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Driving yozz:');
    expect(stderr).toBe('');
  });

  it('logs to stderr, so nothing but the result reaches stdout', () => {
    expect(Effect.runSync(Effect.provide(Effect.service(Logger.LogToStderr), CliLayer))).toBe(true);
  });
});
