import type { MailServer } from '@yozz.app/vault-contract';

/** Mozilla `clientConfig` v1.1 XML. Workers have no DOMParser and the document is flat, so regexes suffice. */

export type ClientConfigServer = {
  readonly host: string;
  readonly port: number;
  readonly socketType: string;
  /** The `<username>` placeholder, e.g. `%EMAILADDRESS%`; absent when the block has none. */
  readonly username: string | null;
};

export type ClientConfig = {
  readonly imap: readonly ClientConfigServer[];
  readonly smtp: readonly ClientConfigServer[];
};

const childText = (block: string, tag: string): string | null => {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return match?.[1] === undefined || match[1] === '' ? null : match[1];
};

const serversOf = (xml: string, element: string, type: string): readonly ClientConfigServer[] => {
  const blocks = xml.matchAll(
    new RegExp(`<${element}\\b[^>]*\\btype="${type}"[^>]*>([\\s\\S]*?)</${element}>`, 'g'),
  );
  const servers: ClientConfigServer[] = [];
  for (const [, block] of blocks) {
    if (block === undefined) continue;
    const host = childText(block, 'hostname');
    const port = Number(childText(block, 'port'));
    if (host === null || !Number.isInteger(port)) continue;
    servers.push({
      host: host.toLowerCase(),
      port,
      socketType: childText(block, 'socketType') ?? '',
      username: childText(block, 'username'),
    });
  }
  return servers;
};

export const parseClientConfig = (xml: string): ClientConfig => {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '');
  return {
    imap: serversOf(stripped, 'incomingServer', 'imap'),
    smtp: serversOf(stripped, 'outgoingServer', 'smtp'),
  };
};

export const usableServer = (
  servers: readonly ClientConfigServer[],
  port: MailServer['port'],
): ClientConfigServer | null =>
  servers.find(server => server.socketType === 'SSL' && server.port === port) ?? null;

/** Every value but `%EMAILLOCALPART%` (`%EMAILADDRESS%`, a literal, nothing) means the whole address. */
export const usernameForm = (server: ClientConfigServer): 'address' | 'localpart' =>
  server.username === '%EMAILLOCALPART%' ? 'localpart' : 'address';
