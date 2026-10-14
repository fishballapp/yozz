/**
 * RFC 7162 §4 asks a client to keep a command line to about 8192 octets. A set stops well short, so
 * the tag, the command and a mailbox name fit beside it.
 */
export const MAX_UID_SET_LENGTH = 4096;

/**
 * Uids as RFC 9051 sequence sets, runs written as ranges (`3:5,9`), split so that no set is longer
 * than `maxLength`: one command per set, however many uids are written to at once.
 */
export const uidSets = (
  uids: Iterable<number>,
  maxLength: number = MAX_UID_SET_LENGTH,
): readonly string[] => {
  const ranges: [first: number, last: number][] = [];
  for (const uid of [...new Set(uids)].toSorted((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last !== undefined && uid === last[1] + 1) {
      last[1] = uid;
    } else {
      ranges.push([uid, uid]);
    }
  }
  const sets: string[] = [];
  let current = '';
  for (const [first, last] of ranges) {
    const range = first === last ? String(first) : `${first}:${last}`;
    if (current !== '' && current.length + 1 + range.length > maxLength) {
      sets.push(current);
      current = '';
    }
    current = current === '' ? range : `${current},${range}`;
  }
  return current === '' ? sets : [...sets, current];
};
