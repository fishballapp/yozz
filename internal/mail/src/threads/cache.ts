import type { ImapMessageSummary } from '@yozz.app/imap';
import type { FetchedBody } from './bodies.ts';
import type { Folder } from './thread.ts';

/**
 * The mail cache: derived from IMAP, rebuilt whenever lost (ARCHITECTURE.md, "State placement").
 * Per account and folder; each client stores it its own way.
 */

export type FolderSync = {
  /** The mailbox `SELECT` names. */
  readonly name: string;
  readonly uidValidity: number;
  readonly lastUid: number;
  /** The folder's oldest message is cached. */
  readonly complete: boolean;
};

export type FolderCache = {
  readonly getSync: () => Promise<FolderSync | null>;
  readonly putSync: (sync: FolderSync) => Promise<void>;
  readonly listSummaries: () => Promise<readonly ImapMessageSummary[]>;
  readonly putSummaries: (summaries: readonly ImapMessageSummary[]) => Promise<void>;
  readonly deleteSummaries: (uids: readonly number[]) => Promise<void>;
  /** Rewrites the summaries cached at `uids` together; a uid not cached stays absent. */
  readonly updateSummaries: (
    uids: readonly number[],
    update: (summary: ImapMessageSummary) => ImapMessageSummary,
  ) => Promise<void>;
  readonly getBody: (uid: number) => Promise<FetchedBody | null>;
  /** The uids of every cached body in the folder. */
  readonly listBodyUids: () => Promise<ReadonlySet<number>>;
  /** The text of every cached body in the folder, without the bodies themselves. */
  readonly listPreviews: () => Promise<
    readonly { readonly uid: number; readonly paragraphs: readonly string[] }[]
  >;
  /** The body and its preview together, so neither exists without the other. */
  readonly putBody: (uid: number, body: FetchedBody) => Promise<void>;
};

export type MailCache = {
  readonly folder: (folder: Folder) => FolderCache;
  /** Every folder at once, or a reused uid could resolve to a stale body. */
  readonly clear: () => Promise<void>;
};
