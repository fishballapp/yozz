export {
  createSmtpClient,
  dotStuff,
  type SmtpCapabilities,
  type SmtpClient,
  type SmtpEnvelope,
} from './client.ts';
export {
  buildMessage,
  encodeHeaderText,
  formatDate,
  formatMailbox,
  type MessageAttachment,
  type MessageInput,
} from './message.ts';
export type { SmtpFailure, SmtpReply, SmtpResult } from './reply.ts';
export type { ByteDuplex } from './transport.ts';
