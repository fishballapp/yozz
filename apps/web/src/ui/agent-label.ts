/**
 * HACKATHON HACK: delete this file after the WebMCP Challenge (deadline 2026-09-03);
 * `grep agentLabel` finds every use.
 *
 * ChatGPT desktop's snapshot drops the value of every `type="email"` input
 * (openai/codex#41504). The accessible name is the only place a value rides that every snapshot
 * keeps; `title`, `aria-description` and `aria-describedby` are all dropped. The visible label
 * stays the first words (WCAG 2.5.3). A screen-reader user hears the address twice.
 */
export const agentLabel = (label: string, value: string) =>
  value === '' ? label : `${label}, currently ${value}`;
