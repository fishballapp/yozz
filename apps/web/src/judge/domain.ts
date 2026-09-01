/** HACKATHON ONLY: delete after 2026-09-03. One place decides which addresses are demo mailboxes. */
export const JUDGE_DOMAIN = 'webmcp-judge.yozz.app';

export const isJudgeAddress = (address: string) => address.endsWith(`@${JUDGE_DOMAIN}`);
