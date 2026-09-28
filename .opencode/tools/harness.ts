// Supervised checkouts load the installed release snapshot, even without checkout node_modules.
// In the operator checkout, npm --prefix tools/harness ci supplies the pinned helper dependency.
const source = process.env.HARNESS_TOOLS_URL ?? new URL('../../tools/harness/templates/opencode/harness.ts', import.meta.url).href;
const tools = await import(source);
export const context = tools.context;
export const evidence = tools.evidence;
export const mail_send = tools.mail_send;
export const mail_read = tools.mail_read;
export const mail_ack = tools.mail_ack;
export const checkpoint = tools.checkpoint;
export const check = tools.check;
export const block = tools.block;
export const submit = tools.submit;
