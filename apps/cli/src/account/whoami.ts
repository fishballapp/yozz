import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  parseAddressRecord,
} from '@yozz.app/mail/addresses/record';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { reportFailure } from '../errors.ts';
import { printJson } from '../output.ts';
import { Vault } from '../vault/vault.ts';

export const whoamiCommand = Command.make(
  'whoami',
  {},
  Effect.fn('account.whoami')(function* () {
    const { account, use } = yield* Vault;
    const records = yield* use(store => store.list(ADDRESS_RECORD_TYPE));
    const addresses = records
      .map(({ plaintext }) => parseAddressRecord(plaintext))
      .filter((record): record is AddressRecord => record !== null)
      .toSorted((a, b) => a.address.localeCompare(b.address));
    if (addresses.length < records.length) {
      yield* Console.error(
        `Skipped ${records.length - addresses.length} address record(s) this version of yozz cannot read.`,
      );
    }
    yield* printJson({
      email: account.email,
      userId: account.userId,
      keyId: account.keyId,
      source: account.source,
      addresses: addresses.map(({ address, senderName, imap }) => ({
        address,
        ...(senderName === undefined ? {} : { name: senderName }),
        receives: imap !== undefined,
      })),
    });
  }, reportFailure),
).pipe(
  Command.withShortDescription('The account, this CLI key, and every address'),
  Command.withDescription(`The account, this CLI key, and every address in the vault.

\`source\` says where the key came from: the credentials file, or YOZZ_CLI_KEY. \`receives\` is true
for an address yozz reads mail for (it has an IMAP side); one without only sends. \`name\` is the
address's display name, when it has one.

Output:
  {
    "email": "jason@fishball.ltd",
    "userId": "u_2b1c…",
    "keyId": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "source": "file",
    "addresses": [
      { "address": "jason@fishball.ltd", "name": "Jason Yu", "receives": true },
      { "address": "noreply@fishball.ltd", "receives": false }
    ]
  }`),
  Command.withExamples([{ command: 'yozz whoami', description: 'Which account and addresses' }]),
  Command.provide(Vault.layer),
);
