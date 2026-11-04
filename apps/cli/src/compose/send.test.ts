import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import { SEND_LEASE_MS } from '@yozz.app/mail/compose/draft-record';
import { appendQuietLimitMs } from '@yozz.app/mail/connection';
import { DATA_END_TIMEOUT_MS } from '@yozz.app/smtp';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as TestClock from 'effect/testing/TestClock';
import { makeFakeImapServer } from '../mail/fake-imap-server.ts';
import { ADDRESS, IMAP_HOST, mail } from '../mail/mail-world.ts';
import { QUIET_LIMIT_MS } from '../mail/servers.ts';
import { failureOf, runCli } from '../test-world.ts';
import { makeComposeWorld, SEND_ONLY } from './compose-world.ts';

/** The ids of the conversations a list prints. */
const idsOf = (stdout: string): string[] =>
  JSON.parse(stdout).threads.map(({ id }: { id: string }) => id);

layer(NodeServices.layer)(it => {
  describe('yozz send', () => {
    it.effect(
      'sends exactly the version drafted, keeps a Sent copy, and the next list shows it',
      () =>
        Effect.gen(function* () {
          const { server, smtp, run, drafts } = yield* makeComposeWorld();
          server.deliver('INBOX', mail(1));
          const { draft } = JSON.parse(
            (yield* run(['draft', '--reply', 'mid/<m1@stripe.com>', '--text', 'Thanks, **paid**.']))
              .stdout,
          );
          const key = draft.id.slice('draft/'.length);

          const { exit, stdout, stderr } = yield* run(['send', draft.draftId]);

          assert.isTrue(Exit.isSuccess(exit), stderr);
          const sent = JSON.parse(stdout);
          expect(sent).toMatchObject({
            sent: true,
            replayed: false,
            threadId: 'mid/<m1@stripe.com>',
            sentCopy: 'stored',
            url: `https://yozz.test/m/sent/t/${encodeURIComponent('mid/<m1@stripe.com>')}`,
          });
          expect(sent.messageId).toMatch(/^mid\/<[0-9a-f-]{36}@fishball\.ltd>$/u);
          // The composer's message: markdown as text, its rendering as HTML, the reply headers.
          expect(smtp.delivered).toHaveLength(1);
          const [delivered] = smtp.delivered;
          expect(delivered?.from).toBe(ADDRESS);
          expect(delivered?.to).toEqual(['billing@stripe.com']);
          expect(delivered?.data).toContain('Subject: Re: Invoice #1');
          expect(delivered?.data).toContain('In-Reply-To: <m1@stripe.com>');
          expect(delivered?.data).toContain(`Message-ID: ${sent.messageId.slice('mid/'.length)}`);
          expect(delivered?.data).toContain('Content-Type: text/html');
          expect(delivered?.data).toContain('<strong>paid</strong>');
          // The Sent copy is those bytes, appended once.
          const sentBox = server.mailboxes.get('Sent')?.messages ?? [];
          expect(sentBox).toHaveLength(1);
          expect(new TextDecoder().decode(sentBox[0]?.raw)).toBe(`${delivered?.data}\r\n`);
          // The draft is a tombstone that remembers what it became.
          expect((yield* drafts)[key]).toMatchObject({
            sentMessageId: sent.messageId.slice('mid/'.length),
          });
          expect((yield* drafts)[key]?.deletedAt).toBeDefined();
          expect((yield* drafts)[key]?.send).toBeUndefined();

          const sentList = yield* run(['list', '--query', 'in:sent']);
          expect(idsOf(sentList.stdout), sentList.stderr).toEqual(['mid/<m1@stripe.com>']);
          expect(JSON.parse(sentList.stdout).threads[0]).toMatchObject({
            messageCount: 2,
            hasDraft: false,
          });
          expect(idsOf((yield* run(['list', '--query', 'in:drafts'])).stdout)).toEqual([]);
        }),
    );

    it.effect('lets each connection wait out a slow answer, then limits it as before', () =>
      Effect.gen(function* () {
        const { server, smtp, run } = yield* makeComposeWorld();
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        yield* run(['send', draft.draftId]);

        expect(smtp.quietLimits).toEqual([DATA_END_TIMEOUT_MS]);
        const copy = server.mailboxes.get('Sent')?.messages[0]?.raw;
        expect(server.quietLimits).toEqual([appendQuietLimitMs(copy?.length ?? 0), QUIET_LIMIT_MS]);
      }),
    );

    it.effect('never sends twice: a repeat is replayed, not resubmitted', () =>
      Effect.gen(function* () {
        const { smtp, run } = yield* makeComposeWorld();
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const first = JSON.parse((yield* run(['send', draft.draftId])).stdout);
        const commands = smtp.commands.length;

        const again = yield* run(['send', draft.draftId]);

        assert.isTrue(Exit.isSuccess(again.exit), again.stderr);
        expect(JSON.parse(again.stdout)).toEqual({ ...first, replayed: true });
        expect(smtp.delivered).toHaveLength(1);
        // No SMTP connection at all.
        expect(smtp.commands).toHaveLength(commands);
      }),
    );

    it.effect(
      'a lost answer after the end of the message is SendUnconfirmed, and nothing is resent',
      () =>
        Effect.gen(function* () {
          const { smtp, run, drafts } = yield* makeComposeWorld();
          const { draft } = JSON.parse(
            (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
          );
          smtp.answer = 'drop';

          const lost = yield* run(['send', draft.draftId]);

          assert.isTrue(Exit.isFailure(lost.exit));
          expect(failureOf(lost.stderr)).toMatchObject({ code: 'SendUnconfirmed' });
          expect(lost.stdout).toBe('');
          expect(smtp.delivered).toHaveLength(1);
          const key = draft.id.slice('draft/'.length);
          expect((yield* drafts)[key]?.send?.state).toBe('unconfirmed');

          smtp.answer = 'accept';
          const commands = smtp.commands.length;
          const again = yield* run(['send', draft.draftId]);
          expect(failureOf(again.stderr)).toMatchObject({ code: 'SendUnconfirmed' });
          const newest = `${key}@${(yield* drafts)[key]?.contentVersion}`;
          const newer = yield* run(['send', newest]);
          expect(failureOf(newer.stderr)).toMatchObject({ code: 'SendUnconfirmed' });
          expect(smtp.delivered).toHaveLength(1);
          expect(smtp.commands).toHaveLength(commands);
          // Nor can it be edited or discarded until the person settles it.
          const edit = yield* run(['draft', '--edit', newest, '--subject', 'Again']);
          expect(failureOf(edit.stderr)).toMatchObject({ code: 'DraftSending' });
          const discard = yield* run(['discard', newest]);
          expect(failureOf(discard.stderr)).toMatchObject({ code: 'DraftSending' });
        }),
    );

    it.effect(
      'leaves a send only the person can settle alone: stuck submitting, or set aside',
      () =>
        Effect.gen(function* () {
          const { smtp, run, drafts, rewriteDraft } = yield* makeComposeWorld();
          const { draft } = JSON.parse(
            (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
          );
          const key = draft.id.slice('draft/'.length);
          smtp.answer = 'drop';
          yield* run(['send', draft.draftId]);
          smtp.answer = 'accept';
          const unconfirmed = (yield* drafts)[key]?.send;
          if (unconfirmed === undefined) throw new Error('the lost send left no claim');
          const commands = smtp.commands.length;

          // A tab closed between the claim and SMTP's answer, and its lease over: the record still says submitting.
          yield* TestClock.adjust(SEND_LEASE_MS);
          const stuck = yield* rewriteDraft(key, record => ({
            ...record,
            send: { ...unconfirmed, state: 'submitting' },
          }));
          const fromStuck = yield* run(['send', stuck]);
          expect(failureOf(fromStuck.stderr)).toMatchObject({ code: 'SendUnconfirmed' });

          // Back to editing in yozz.app: the send is set aside, and the draft can be edited.
          const setAside = yield* rewriteDraft(key, ({ send: _send, ...record }) => ({
            ...record,
            unconfirmedSend: unconfirmed,
          }));
          const fromSetAside = yield* run(['send', setAside]);
          expect(failureOf(fromSetAside.stderr)).toMatchObject({ code: 'SendUnconfirmed' });

          expect(smtp.commands).toHaveLength(commands);
          expect(smtp.delivered).toHaveLength(1);
        }),
    );

    it.effect('a refusal releases the claim: nothing went out, and the draft sends again', () =>
      Effect.gen(function* () {
        const { smtp, run, drafts } = yield* makeComposeWorld();
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const key = draft.id.slice('draft/'.length);
        smtp.answer = 'refuse';

        const refused = yield* run(['send', draft.draftId]);

        assert.isTrue(Exit.isFailure(refused.exit));
        // Claimed at 2, released at 3.
        expect(failureOf(refused.stderr)).toMatchObject({
          code: 'SendRefused',
          address: ADDRESS,
          currentDraftId: `${key}@3`,
        });
        expect(smtp.delivered).toHaveLength(0);
        expect((yield* drafts)[key]?.send).toBeUndefined();

        smtp.answer = 'accept';
        const retried = yield* run(['send', `${key}@3`]);
        assert.isTrue(Exit.isSuccess(retried.exit), retried.stderr);
        expect(smtp.delivered).toHaveLength(1);
      }),
    );

    it.effect('refuses a version that is not the newest, and sends nothing', () =>
      Effect.gen(function* () {
        const { smtp, run } = yield* makeComposeWorld();
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const edited = JSON.parse(
          (yield* run(['draft', '--edit', draft.draftId, '--subject', 'Changed'])).stdout,
        ).draft;

        const stale = yield* run(['send', draft.draftId]);

        expect(failureOf(stale.stderr)).toMatchObject({
          code: 'Conflict',
          currentDraftId: edited.draftId,
        });
        expect(smtp.commands).toEqual([]);
      }),
    );

    it.effect('finishes a send with no Sent folder, and says no copy was kept, every time', () =>
      Effect.gen(function* () {
        const { server, smtp, run, drafts } = yield* makeComposeWorld();
        server.mailboxes.delete('Sent');
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const key = draft.id.slice('draft/'.length);

        const first = yield* run(['send', draft.draftId]);
        assert.isTrue(Exit.isSuccess(first.exit), first.stderr);
        expect(JSON.parse(first.stdout)).toMatchObject({
          sent: true,
          replayed: false,
          sentCopy: 'none',
        });
        expect((yield* drafts)[key]?.deletedAt).toBeDefined();

        const again = yield* run(['send', draft.draftId]);
        expect(JSON.parse(again.stdout)).toMatchObject({ replayed: true, sentCopy: 'none' });
        expect(smtp.delivered).toHaveLength(1);
      }),
    );

    it.effect('finishes a send that went out but kept no Sent copy, without SMTP', () =>
      Effect.gen(function* () {
        const { world, homes, servers, server, smtp, run, drafts } = yield* makeComposeWorld();
        const dropsAppend = makeFakeImapServer({
          username: ADDRESS,
          password: 'secret',
          quirks: { dropsOn: command => command.startsWith('APPEND') },
        });
        const runWhileDropping = (args: readonly string[]) =>
          runCli(args, {
            fetch: world.fetch,
            homes,
            servers: { ...servers, [IMAP_HOST]: dropsAppend },
          });
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const key = draft.id.slice('draft/'.length);

        const pending = yield* runWhileDropping(['send', draft.draftId]);

        assert.isTrue(Exit.isSuccess(pending.exit), pending.stderr);
        expect(JSON.parse(pending.stdout)).toMatchObject({ sent: true, sentCopy: 'pending' });
        expect((yield* drafts)[key]?.send?.state).toBe('submitted');

        // Each run takes the send over under a claim of its own, so no other can run beside it.
        const firstClaim = (yield* drafts)[key]?.send?.opId;
        yield* runWhileDropping(['send', draft.draftId]);
        expect((yield* drafts)[key]?.send?.opId).not.toBe(firstClaim);

        const commands = smtp.commands.length;
        const finished = yield* run(['send', draft.draftId]);
        assert.isTrue(Exit.isSuccess(finished.exit), finished.stderr);
        expect(JSON.parse(finished.stdout)).toMatchObject({
          sent: true,
          replayed: true,
          sentCopy: 'stored',
        });
        expect(smtp.commands).toHaveLength(commands);
        expect(smtp.delivered).toHaveLength(1);
        expect(server.mailboxes.get('Sent')?.messages).toHaveLength(1);
        expect((yield* drafts)[key]?.deletedAt).toBeDefined();
      }),
    );

    it.effect('refuses a draft a send holds now, and sends nothing', () =>
      Effect.gen(function* () {
        const { run, smtp, rewriteDraft } = yield* makeComposeWorld();
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const key = draft.id.slice('draft/'.length);
        const claim = {
          messageId: '<elsewhere@fishball.ltd>',
          opId: 'op-elsewhere',
          claimedAt: yield* Clock.currentTimeMillis,
          message: { head: btoa('Subject: x\r\n\r\nx'), splices: [] },
          target: { account: ADDRESS, folder: 'sent' },
        };
        for (const state of ['submitting', 'submitted'] as const) {
          const claimed = yield* rewriteDraft(key, record => ({
            ...record,
            send: { ...claim, state },
          }));
          const sent = yield* run(['send', claimed]);
          expect(failureOf(sent.stderr), state).toMatchObject({ code: 'DraftSending' });
        }
        expect(smtp.delivered).toHaveLength(0);
      }),
    );

    it.effect('keeps the Sent copy of a send-only address in the vault, which lists show', () =>
      Effect.gen(function* () {
        const { sendOnlySmtp, run, addSendOnly } = yield* makeComposeWorld();
        yield* addSendOnly();
        const { draft } = JSON.parse(
          (yield* run([
            'draft',
            '--from',
            SEND_ONLY,
            '--to',
            'kate@example.com',
            '--subject',
            'Hi',
          ])).stdout,
        );

        const sent = yield* run(['send', draft.draftId]);

        assert.isTrue(Exit.isSuccess(sent.exit), sent.stderr);
        expect(JSON.parse(sent.stdout)).toMatchObject({ sentCopy: 'stored' });
        expect(sendOnlySmtp.delivered).toHaveLength(1);
        const listed = yield* run(['list', '--query', 'in:sent']);
        expect(idsOf(listed.stdout), listed.stderr).toEqual([JSON.parse(sent.stdout).messageId]);
      }),
    );

    it.effect('sends the files the draft names, read from R2, intact in the message', () =>
      Effect.gen(function* () {
        const { homes, server, smtp, run, drafts, world } = yield* makeComposeWorld();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(homes.XDG_STATE_HOME, { recursive: true });
        const receipt = path.join(homes.XDG_STATE_HOME, 'receipt.pdf');
        yield* fs.writeFileString(receipt, '%PDF-1.7 receipt');
        const { draft } = JSON.parse(
          (yield* run([
            'draft',
            '--from',
            ADDRESS,
            '--to',
            'kate@example.com',
            '--attach',
            receipt,
          ])).stdout,
        );

        const key = draft.id.slice('draft/'.length);
        yield* run(['send', draft.draftId]);

        const data = smtp.delivered[0]?.data ?? '';
        expect(data).toContain('Content-Type: application/pdf');
        expect(data).toContain('filename="receipt.pdf"');
        expect(data).toContain(new TextEncoder().encode('%PDF-1.7 receipt').toBase64());
        // The Sent copy is the same message, and the tombstone stops naming the file.
        const sentBox = server.mailboxes.get('Sent')?.messages ?? [];
        expect(new TextDecoder().decode(sentBox[0]?.raw)).toBe(`${data}\r\n`);
        expect((yield* drafts)[key]?.attachments).toBeUndefined();
        expect((yield* drafts)[key]?.deletedAt).toBeDefined();
        // Left for collection, which does not run from a send.
        expect(world.files.size).toBe(1);
      }),
    );

    it.effect('gives the draft back, sending nothing, when a file cannot be read', () =>
      Effect.gen(function* () {
        const { homes, smtp, run, drafts, world } = yield* makeComposeWorld();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(homes.XDG_STATE_HOME, { recursive: true });
        const receipt = path.join(homes.XDG_STATE_HOME, 'receipt.pdf');
        yield* fs.writeFileString(receipt, 'x');
        const { draft } = JSON.parse(
          (yield* run([
            'draft',
            '--from',
            ADDRESS,
            '--to',
            'kate@example.com',
            '--attach',
            receipt,
          ])).stdout,
        );
        const key = draft.id.slice('draft/'.length);
        for (const id of world.files.keys()) world.loseFile(id);

        const refused = yield* run(['send', draft.draftId]);

        assert.isTrue(Exit.isFailure(refused.exit));
        expect(failureOf(refused.stderr)).toMatchObject({
          code: 'SendRefused',
          currentDraftId: `${key}@3`,
        });
        // Nothing to reopen at a terminal: it names the version to send instead.
        expect((failureOf(refused.stderr) as { message: string }).message).toBe(
          `${ADDRESS}: Couldn’t download receipt.pdf. Nothing went out; the draft is back as ${key}@3`,
        );
        expect(smtp.commands).toEqual([]);
        expect((yield* drafts)[key]?.send).toBeUndefined();
        expect((yield* drafts)[key]?.attachments).toHaveLength(1);
      }),
    );

    it.effect('keeps a send-only copy naming its files in R2, which read downloads', () =>
      Effect.gen(function* () {
        const { homes, sendOnlySmtp, run, world, addSendOnly } = yield* makeComposeWorld();
        yield* addSendOnly();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(homes.XDG_STATE_HOME, { recursive: true });
        const receipt = path.join(homes.XDG_STATE_HOME, 'receipt.pdf');
        yield* fs.writeFileString(receipt, '%PDF-1.7 receipt');
        const { draft } = JSON.parse(
          (yield* run([
            'draft',
            '--from',
            SEND_ONLY,
            '--to',
            'kate@example.com',
            '--subject',
            'Receipt',
            '--attach',
            receipt,
          ])).stdout,
        );

        const sent = JSON.parse((yield* run(['send', draft.draftId])).stdout);

        expect(sendOnlySmtp.delivered[0]?.data).toContain(
          new TextEncoder().encode('%PDF-1.7 receipt').toBase64(),
        );
        const [record] = yield* world.readRecords('sent');
        const parsed = JSON.parse(record?.plaintext ?? '{}');
        expect(parsed.attachments).toMatchObject([{ name: 'receipt.pdf', size: 16 }]);
        expect(parsed.message.splices).toHaveLength(1);
        expect(parsed.date).toMatch(/\d{4} \d\d:\d\d:\d\d/u);
        expect(parsed.bytes).toBeUndefined();

        const saveTo = path.join(homes.XDG_STATE_HOME, 'saved');
        const read = yield* run(['read', sent.messageId, '--save-attachments', saveTo]);
        assert.isTrue(Exit.isSuccess(read.exit), read.stderr);
        const message = JSON.parse(read.stdout).threads[0].messages[0];
        expect(message.attachments).toMatchObject([
          { type: 'application/pdf', size: 16, untrusted: { name: 'receipt.pdf' } },
        ]);
        expect(yield* fs.readFileString(message.attachments[0].path)).toBe('%PDF-1.7 receipt');
      }),
    );
  });
});
