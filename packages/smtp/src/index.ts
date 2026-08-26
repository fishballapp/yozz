/**
 * @yozz.app/smtp — transport-agnostic SMTP client core plus an RFC 5322 message builder.
 */
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
