import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { isInbound } from '../lib/addresses';
import { withCompose } from '../lib/compose';
import { isArchived, isTrashed } from '../lib/thread';
import { useMail } from '../state/mail';
import { type AgentPort, buildAgentTools } from './tools';

/**
 * Registers the tools on `document.modelContext` behind the vault gate, once, under one
 * `AbortController`. The tools read the store through a ref: re-registering on every sync would
 * fire `toolchange` and race abort-then-register under StrictMode. Renders nothing.
 */
export const AgentTools = () => {
  const mail = useMail();
  const navigate = useNavigate();
  // `strict: false`: this sits above every page.
  const { mailbox } = useParams({ strict: false });

  const mailRef = useRef(mail);
  const port: AgentPort = {
    addresses: mail.identities.map(record => ({
      address: record.address,
      isInbound: isInbound(record),
    })),
    identities: mail.identities,
    ownedAddresses: mail.ownedAddresses,
    threads: mail.threads,
    drafts: mail.drafts,
    loadBody: mail.loadBody,
    // Flushed, so a tool's result describes the state after the write.
    markRead: threadId => flushSync(() => mail.markRead(threadId)),
    markUnread: threadId => flushSync(() => mail.markUnread(threadId)),
    archive: threadId => {
      const thread = mail.threads.find(candidate => candidate.id === threadId);
      if (thread === undefined || isArchived(thread)) return true;
      return flushSync(() => mail.toggleArchive(threadId));
    },
    setStar: (threadId, isStarred) => {
      const thread = mail.threads.find(candidate => candidate.id === threadId);
      if (thread === undefined || thread.isStarred === isStarred) return true;
      return flushSync(() => mail.toggleStar(threadId));
    },
    trash: threadId => {
      const thread = mail.threads.find(candidate => candidate.id === threadId);
      if (thread === undefined || isTrashed(thread)) return true;
      return flushSync(() => mail.trashThread(threadId));
    },
    restore: threadId => {
      const thread = mail.threads.find(candidate => candidate.id === threadId);
      if (thread === undefined || !(isArchived(thread) || isTrashed(thread))) return true;
      return flushSync(() => mail.restoreThread(threadId));
    },
    writeDraft: input => mailRef.current.writeDraft(input),
    removeDraft: draftId => mailRef.current.removeDraft(draftId),
    openThread: async thread => {
      await navigate({
        to: '/m/$mailbox/t/$',
        params: { mailbox: mailbox ?? 'unified', _splat: thread.id },
        search: previous => previous,
      });
    },
    // The composer opens on a draft the vault already holds; nothing is staged in memory.
    openDraft: async draftKey => {
      await navigate({ to: '.', search: withCompose(`draft:${draftKey}`) });
    },
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
        if (outcome.reason instanceof DOMException && outcome.reason.name === 'AbortError')
          continue;
        // biome-ignore lint/suspicious/noConsole: a refused tool must be visible in DevTools; the app works without it
        console.warn('WebMCP tool did not register', outcome.reason);
      }
    })();
    return () => controller.abort();
  }, []);

  return null;
};
