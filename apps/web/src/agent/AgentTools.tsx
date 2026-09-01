import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { isInbound } from '../lib/addresses';
import { withCompose } from '../lib/compose';
import { isArchived, isTrashed } from '../lib/thread';
import { useMail } from '../state/mail';
import { type AgentPort, buildAgentTools } from './tools';

/**
 * Registers the agent tools on `document.modelContext` for as long as it is mounted, and it is
 * mounted inside `AppShellBody`: behind the vault gate, so there are no tools on `/login`, and
 * unmounted by sign-out or lock, so no tool outlives the session that could read the mail.
 *
 * Registered ONCE, under one `AbortController` the cleanup aborts. The tools read the live store
 * through a ref rather than being re-registered on every sync: re-registering would fire
 * `toolchange` on every change and race abort-then-register under StrictMode's double mount.
 *
 * Renders nothing. A browser without WebMCP mounts it silently.
 */
export const AgentTools = () => {
  const mail = useMail();
  const navigate = useNavigate();
  // `strict: false`: this sits above every page. A thread is opened in the mailbox on screen when
  // there is one, so the list beside it stays put; otherwise in the inbox.
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
    // Every write is flushed: a tool's result, and the next tool's view, describe the state AFTER
    // the write, not the render React would otherwise get to later.
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
    /**
     * The composer opens on a draft the vault ALREADY holds: `save_draft` wrote it and the URL
     * names it. Nothing is staged in memory for the composer to pick up, so there is no claim to
     * win and nothing to read back — what the user sees is the record.
     */
    openDraft: async draftKey => {
      await navigate({ to: '.', search: withCompose(`draft:${draftKey}`) });
    },
  };
  // Assigned in render, not in an effect: after `flushSync` the re-render has happened but passive
  // effects have not, and the tool that just wrote reads the port next.
  const portRef = useRef(port);
  portRef.current = port;
  // The store itself: a draft write is awaited across the renders it causes, and the `mail` in a
  // closure from before one of them is the one that has not seen it.
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
