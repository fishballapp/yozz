/**
 * RFC 8448's traces parsed out of the RFC's own text (committed verbatim; see README.md for the
 * pin). Each field's declared octet count is checked against what was read, so a hex run
 * truncated at a page break cannot pass as a shorter vector.
 */

import { readFileSync } from 'node:fs';

export type Rfc8448Field = {
  /** The label with its `(N octets)` size stripped — `PRK`, `key info`, `expanded`. */
  readonly label: string;
  readonly bytes: Uint8Array;
};

export type Rfc8448Step = {
  readonly actor: 'client' | 'server';
  /** Verbatim, minus the actor — `derive secret "tls13 c hs traffic"`. */
  readonly title: string;
  readonly fields: readonly Rfc8448Field[];
};

export type Rfc8448Trace = {
  /** The RFC's own section number: `3` through `7`. */
  readonly section: string;
  readonly title: string;
  readonly steps: readonly Rfc8448Step[];
};

const SECTION = /^(\d+)\. {2}(.+)$/;
const STEP = /^ {3}\{(client|server)\} {2}(.*?):?$/;
const FIELD = /^ {6}(\S[^:]*):(?: {2}(.*))?$/;
const CONTINUATION = /^ {9}(.*)$/;
const RUNNING_HEAD = /^(Thomson +Informational +\[Page \d+\]|RFC 8448 .+January 2019)$/;
const DECLARED_OCTETS = /^(.+) \((\d+) octets\)$/;

/**
 * The RFC's two prose stand-ins for bytes. `0 (all zero octets)` is the Early Secret's salt,
 * which RFC 5869 §2.2 defines as HashLen zeros; `hkdfExtract` applies that rule itself.
 */
const bytesFrom = (label: string, value: string): Uint8Array => {
  if (value === '(empty)' || value === '0 (all zero octets)') return new Uint8Array(0);
  const octets = value.split(' ').filter(part => part.length > 0);
  const invalid = octets.find(part => !/^[0-9a-f]{2}$/.test(part));
  if (invalid !== undefined) throw new Error(`RFC 8448: "${label}" is not hex, at "${invalid}"`);
  return Uint8Array.from(octets, part => Number.parseInt(part, 16));
};

type MutableStep = { actor: 'client' | 'server'; title: string; fields: Rfc8448Field[] };
type MutableTrace = { section: string; title: string; steps: MutableStep[] };
type PendingField = { label: string; declaredLength: number | null; value: string };

const parse = (text: string): readonly Rfc8448Trace[] => {
  const traces: MutableTrace[] = [];
  let step: MutableStep | undefined;
  let pending: PendingField | undefined;

  const flush = (): void => {
    if (pending === undefined) return;
    const { label, declaredLength, value } = pending;
    pending = undefined;
    if (step === undefined) throw new Error(`RFC 8448: field "${label}" outside any step`);
    const bytes = bytesFrom(label, value);
    if (declaredLength !== null && declaredLength !== bytes.length) {
      throw new Error(
        `RFC 8448: "${label}" declares ${declaredLength} octets but ${bytes.length} were read`,
      );
    }
    step.fields.push({ label, bytes });
  };

  // Form feeds mark the page breaks that split hex runs; dropping them leaves the running head
  // on its own line for the filter below.
  for (const line of text.replaceAll('\f', '').split('\n')) {
    if (line.trim() === '' || RUNNING_HEAD.test(line)) continue;

    const continuation = CONTINUATION.exec(line);
    if (continuation !== null && pending !== undefined) {
      pending.value = `${pending.value} ${continuation[1]?.trim() ?? ''}`.trim();
      continue;
    }

    flush();

    const section = SECTION.exec(line);
    if (section !== null) {
      const [, number, title] = section;
      if (number === undefined || title === undefined) throw new Error(`unreachable: ${line}`);
      traces.push({ section: number, title, steps: [] });
      step = undefined;
      continue;
    }

    const heading = STEP.exec(line);
    if (heading !== null) {
      const [, actor, title] = heading;
      if (actor === undefined || title === undefined) throw new Error(`unreachable: ${line}`);
      step = { actor: actor === 'client' ? 'client' : 'server', title, fields: [] };
      traces.at(-1)?.steps.push(step);
      continue;
    }

    const field = FIELD.exec(line);
    if (field !== null && step !== undefined) {
      const [, label, value] = field;
      if (label === undefined) throw new Error(`unreachable: ${line}`);
      const declared = DECLARED_OCTETS.exec(label);
      pending = {
        label: declared?.[1] ?? label,
        declaredLength: declared?.[2] === undefined ? null : Number.parseInt(declared[2], 10),
        value: value ?? '',
      };
      continue;
    }

    // A wrapped step title continues at the field indent without a colon; every wrapped title
    // is a `(same as …)` step, which carries no fields.
    if (step !== undefined && step.fields.length === 0 && line.startsWith('      ')) {
      step.title = `${step.title} ${line.trim()}`;
    }
  }
  flush();

  return traces.filter(trace => trace.steps.length > 0);
};

export const RFC_8448_TRACES = parse(
  readFileSync(new URL('./rfc8448.txt', import.meta.url), 'utf8'),
);
