import { Navigate } from '@tanstack/react-router';
import { pairingCode } from '@yozz.app/vault';
import type { CliApproveQuery } from '@yozz.app/vault-contract';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Definition } from '../ui/PageSection';
import { AuthColumn } from '../vault/AuthColumn';
import { approveCliLogin, cliCallbackUrl, parseCliApproveQuery } from '../vault/cli-keys';
import { useVault } from '../vault/session';
import { useSignInChange } from './settings/SignInChange';

/** Every string on this page, so a copy pass rewrites them in one place. */
const COPY = {
  invalidTitle: 'This link isn’t a YOZZ CLI approval',
  /** `command` is `yozz login`, set in mono as a machine value. */
  invalidBody: (command: ReactNode) => (
    <>
      Part of it is missing or is not what {command} writes. Run {command} in your terminal again
      and open the link it prints.
    </>
  ),
  title: 'Approve a command-line client',
  description: (command: ReactNode) => <>{command} is asking to open your mail from a terminal.</>,
  codeLabel: 'Pairing code',
  codeNote:
    'Check that your terminal shows this same code. If it shows another, someone else made this link: deny it.',
  computer: 'Computer',
  account: 'Account',
  grantsLabel: 'What approving allows',
  grantsLead: 'This computer can read, triage, draft and send your mail through YOZZ',
  grantsUntil: ' until you revoke its key in Settings → Sign-in.',
  grantsCaveat: 'Revoking stops it from then on. It cannot take back what it has already read.',
  approve: 'Approve',
  approving: 'Approving…',
  deny: 'Deny',
  approved: 'Approved. Your terminal takes it from here.',
  denied: 'Denied. Your terminal has been told.',
  status: 'Command-line approval',
  freshSignIn:
    'You signed in more than a day ago. Approving a CLI needs a fresh sign-in, so a session someone else got hold of cannot do it. Your approval goes through right after.',
} as const;

const COMMAND = <span className="font-mono text-paper">yozz login</span>;

/**
 * `/cli/approve`: the unlocked tab's half of `yozz login`. Locked, it goes through Log in and comes
 * back with the query as the CLI wrote it. Nothing about the approval is kept in the browser.
 */
export const CliApprove = ({ search }: { search: string }) => {
  const { session, isResuming } = useVault();
  const query = parseCliApproveQuery(search);

  if (query === null) {
    return (
      <AuthColumn title={COPY.invalidTitle} status={COPY.status}>
        <p className="text-base leading-relaxed text-paper-dim">{COPY.invalidBody(COMMAND)}</p>
      </AuthColumn>
    );
  }
  if (isResuming) return null;
  if (session === null) {
    return <Navigate to="/login" search={{ approve: search.replace(/^\?/, '') }} replace />;
  }
  return <Approval query={query} />;
};

const Approval = ({ query }: { query: CliApproveQuery }) => {
  const { session } = useVault();
  const { busy, errors, run, confirmDialog } = useSignInChange<'approve'>({
    approve: COPY.freshSignIn,
  });
  const [answer, setAnswer] = useState<'approved' | 'denied' | null>(null);
  const code = usePairingCode(query.publicKey);

  if (session === null) return null;
  const isSettled = busy !== null || answer !== null;

  return (
    <AuthColumn title={COPY.title} description={COPY.description(COMMAND)} status={COPY.status}>
      <section>
        <h2 className="label-rule">{COPY.codeLabel}</h2>
        <p className="mt-3 font-mono text-[1.5rem] leading-none tracking-[0.12em] text-paper">
          {code ?? ' '}
        </p>
        <p className="mt-3 text-base leading-relaxed text-paper-dim">{COPY.codeNote}</p>
      </section>

      <dl className="mt-6">
        <Definition term={COPY.computer}>{query.name}</Definition>
        <Definition term={COPY.account}>{session.email}</Definition>
      </dl>

      <div className="mt-6 border-y border-rule bg-ink-raised px-4 py-3.5">
        <p className="label-rule">{COPY.grantsLabel}</p>
        <p className="mt-2 text-base leading-relaxed text-paper-dim">
          <span className="text-paper">{COPY.grantsLead}</span>
          {COPY.grantsUntil} {COPY.grantsCaveat}
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={isSettled || code === null}
          onClick={() =>
            void run('approve', async isCurrent => {
              const approved = await approveCliLogin({ session, query, isCurrent });
              if (approved.outcome !== 'approved') return;
              setAnswer('approved');
              window.location.replace(approved.callbackUrl);
            })
          }
        >
          {busy === 'approve' ? COPY.approving : COPY.approve}
        </Button>
        <Button
          variant="ghost"
          disabled={isSettled}
          onClick={() => {
            setAnswer('denied');
            window.location.replace(
              cliCallbackUrl(query.port, { state: query.state, error: 'denied' }),
            );
          }}
        >
          {COPY.deny}
        </Button>
      </div>
      {answer !== null && (
        <p role="status" aria-live="polite" className="mt-4 text-base text-paper-dim">
          {answer === 'approved' ? COPY.approved : COPY.denied}
        </p>
      )}
      {errors.approve !== undefined && (
        <p role="alert" className="mt-4 text-base text-danger">
          {errors.approve}
        </p>
      )}
      {confirmDialog}
    </AuthColumn>
  );
};

/** `null` while the digest is computed; the schema has already refused a key it could not take. */
const usePairingCode = (publicKey: string): string | null => {
  const [computed, setComputed] = useState<{ publicKey: string; code: string } | null>(null);
  useEffect(() => {
    void (async () => setComputed({ publicKey, code: await pairingCode(publicKey) }))();
  }, [publicKey]);
  return computed?.publicKey === publicKey ? computed.code : null;
};
