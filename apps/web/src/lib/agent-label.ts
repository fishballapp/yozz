/**
 * HACKATHON HACK — delete this file after the WebMCP Challenge (deadline 2026-09-03).
 * Tracked as item 0 of HANDOFF.md's Next; `grep agentLabel` finds every use.
 *
 * ChatGPT desktop's page snapshot drops the value of every `type="email"` input, so an agent
 * reading a form back sees an empty field however plainly it is filled
 * ([openai/codex#41504](https://github.com/openai/codex/issues/41504)). Playwright 1.61's own
 * AI-mode snapshot carries the value, so this is that build, not the web platform.
 *
 * The accessible NAME is the only place a value can ride that every snapshot keeps: of the five
 * ways tried, `title`, `aria-description` and the `aria-describedby` relationship are all dropped.
 * The visible label stays the first words, so it is still the name a voice-control user speaks
 * (WCAG 2.5.3).
 *
 * Every email field in the app uses it, not only the composer's: a judge may well hand the whole
 * task to an agent, credentials included, and log in through it.
 *
 * The cost, and why it is dated: an agent reads what a screen reader reads, so a screen-reader
 * user hears the address in the field's name and again as its value.
 */
export const agentLabel = (label: string, value: string) =>
  value === '' ? label : `${label}, currently ${value}`;
