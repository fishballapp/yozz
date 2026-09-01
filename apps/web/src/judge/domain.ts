/**
 * HACKATHON ONLY — delete this folder after the WebMCP Challenge (deadline 2026-09-03).
 *
 * One place decides which addresses are demo mailboxes. The banner, the reset and the minting
 * harness all read it: when they disagreed, a judge account on another domain got a working
 * mailbox and an app that never offered it Reset.
 */
export const JUDGE_DOMAIN = 'webmcp-judge.yozz.app';

export const isJudgeAddress = (address: string) => address.endsWith(`@${JUDGE_DOMAIN}`);
