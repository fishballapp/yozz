export {
  createSmtpClient,
  dotStuff,
  type SmtpCapabilities,
  type SmtpClient,
  type SmtpEnvelope,
} from './client.ts';
export {
  buildMessage,
  buildMessageParts,
  encodeAttachmentBody,
  encodeHeaderText,
  formatDate,
  formatMailbox,
  type MessageAttachment,
  type MessageAttachmentHead,
  type MessageInput,
  type MessageParts,
  spliceMessage,
} from './message.ts';
export type { SmtpFailure, SmtpReply, SmtpResult } from './reply.ts';
export type { ByteDuplex } from './transport.ts';
