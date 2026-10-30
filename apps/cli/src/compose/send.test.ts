import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { ADDRESS, mail } from '../mail/mail-world.ts';
import { failureOf } from '../test-world.ts';
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

          const sentList = yield* run(['list', '--mailbox', 'sent']);
          expect(idsOf(sentList.stdout), sentList.stderr).toEqual(['mid/<m1@stripe.com>']);
          expect(JSON.parse(sentList.stdout).threads[0]).toMatchObject({
            messageCount: 2,
            hasDraft: false,
          });
          expect(idsOf((yield* run(['list', '--mailbox', 'drafts'])).stdout)).toEqual([]);
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

          // A tab closed between the claim and SMTP's answer: the record still says submitting.
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

    it.effect('finishes a send that went out but kept no Sent copy, without SMTP', () =>
      Effect.gen(function* () {
        const { server, smtp, run, drafts } = yield* makeComposeWorld();
        const sentFolder = server.mailboxes.get('Sent');
        server.mailboxes.delete('Sent');
        const { draft } = JSON.parse(
          (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
        );
        const key = draft.id.slice('draft/'.length);

        const pending = yield* run(['send', draft.draftId]);

        assert.isTrue(Exit.isSuccess(pending.exit), pending.stderr);
        expect(JSON.parse(pending.stdout)).toMatchObject({ sent: true, sentCopy: 'pending' });
        expect((yield* drafts)[key]?.send?.state).toBe('submitted');

        if (sentFolder !== undefined) server.mailboxes.set('Sent', sentFolder);
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
        const listed = yield* run(['list', '--mailbox', 'sent']);
        expect(idsOf(listed.stdout), listed.stderr).toEqual([JSON.parse(sent.stdout).messageId]);
      }),
    );

    it.effect('sends the files attached on this machine, and forgets them once sent', () =>
      Effect.gen(function* () {
        const { homes, smtp, run } = yield* makeComposeWorld();
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

        yield* run(['send', draft.draftId]);

        const data = smtp.delivered[0]?.data ?? '';
        expect(data).toContain('Content-Type: application/pdf');
        expect(data).toContain('filename="receipt.pdf"');
        expect(data).toContain(new TextEncoder().encode('%PDF-1.7 receipt').toBase64());
        const kept = yield* fs.readDirectory(
          path.join(homes.XDG_STATE_HOME, 'yozz', 'user_1', 'drafts'),
        );
        expect(kept).toEqual([]);
      }),
    );
  });
});
