// Scoped tools deliberately fail outside an owned harness worker. No operator credential is exposed.
export { context, mail_send, mail_read, mail_ack, checkpoint, block, submit } from '../../tools/harness/templates/opencode/harness';
