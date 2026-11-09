import { useNavigate, useParams } from '@tanstack/react-router';
import { isInbound } from '@yozz.app/mail/addresses/record';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { withCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { type AgentPort, buildAgentTools } from './tools';

/**
 * Registers once, under one `AbortController`. The tools read the store through a ref:
 * re-registering on every sync would fire `toolchange` and race abort-then-register under
 * StrictMode.
 */
export const AgentTools = () => {
  const mail = useMail();
  const navigate = useNavigate();
  // `strict: false`: this sits above every page.
  const { view } = useParams({ strict: false });

  const mailRef = useRef(mail);
  const port: AgentPort = {
    addresses: mail.identities.map(record => ({
      address: record.address,
      isInbound: isInbound(record),
    })),
    identities: mail.identities,
    ownedAddresses: mail.ownedAddresses,
    mailboxes: mail.mailboxes,
    threads: mail.threads,
    windows: mail.windows,
    syncStates: mail.syncStates,
    askServers: async query => {
      const { answers, failed } = await mailRef.current.askServersAndWait(query);
      return {
        answers,
        failed: failed.map(({ address, failure }) => ({
          address,
          failure,
          reason: describeMailFailure(
            failure,
            mailRef.current.mailboxes.find(mailbox => mailbox.address === address)?.imap.host ??
              address,
          ),
        })),
      };
    },
    drafts: mail.drafts,
    loadBody: mail.loadBody,
    // Flushed, so a tool's result describes the state after the write.
    setRead: (threadIds, isRead) =>
      flushSync(() => mail.flagThreads(threadIds, 'isUnread', !isRead)),
    setStar: (threadIds, isStarred) =>
      flushSync(() => mail.flagThreads(threadIds, 'isStarred', isStarred)),
    move: (threadIds, to) => flushSync(() => mail.moveThreads(threadIds, to)),
    junkFolders: mail.junkFolders,
    writeDraft: input => mailRef.current.writeDraft(input),
    removeDraft: draftId => mailRef.current.removeDraft(draftId),
    openThread: async thread => {
      await navigate({
        to: '/m/$view/t/$',
        params: { view: view ?? 'unified', _splat: thread.id },
        search: previous => previous,
      });
    },
    // The composer opens on a draft the vault already holds; nothing is staged in memory.
    openDraft: async draftKey => {
      await navigate({ to: '.', search: withCompose(`draft:${draftKey}`) });
    },
    watchSession: mail.watchSession,
  };
  // Assigned in render: after `flushSync` passive effects have not run, and the tool reads the port next.
  const portRef = useRef(port);
  portRef.current = port;
  // A draft write is awaited across the renders it causes.
  mailRef.current = mail;

  useEffect(() => {
    const modelContext = document.modelContext;
    if (modelContext === undefined) return;
    const controller = new AbortController();
    void (async () => {
      const outcomes = await Promise.allSettled(
        buildAgentTools(() => portRef.current).map(tool =>
          modelContext.registerTool(tool, { signal: controller.signal }),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status !== 'rejected') continue;
        // Aborted before it registered: StrictMode's double mount, or a sign-out mid-registration.
        if (outcome.reason instanceof DOMException && outcome.reason.name === 'AbortError') {
          continue;
        }
        // biome-ignore lint/suspicious/noConsole: a refused tool must be visible in DevTools; the app works without it
        console.warn('WebMCP tool did not register', outcome.reason);
      }
    })();
    return () => controller.abort();
  }, []);

  return null;
};
