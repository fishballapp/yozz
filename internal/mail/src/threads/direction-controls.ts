/**
 * The characters that set the order text is drawn in, rather than being drawn: the embeddings and
 * overrides (LRE, RLE, PDF, LRO, RLO: `invoice\u202Efdp.exe` is drawn `invoiceexe.pdf`) and the
 * isolates (LRI, RLI, FSI, PDI), which stay in force past the end of a string that never closes them.
 */
const REORDERING = /[\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Mail text with what could reorder the text around it taken out, and ordinary right-to-left text
 * left alone.
 *
 * Kept: the marks (LRM, RLM, ALM), which Hebrew and Arabic use to place a bracket or a question
 * mark and which reorder nothing beyond that. A name or a subject is drawn with `dir="auto"`, so a
 * right-to-left one needs no embedding or isolate to read correctly, and plain mail text has no
 * other use for one.
 *
 * Applied where a sender's name, a subject and a recipient's name become a `Message`, so the web
 * app, the agent tools and the CLI show the same text; the CLI's `untrusted` also runs it over
 * every other string it prints, bodies included.
 */
export const withoutDirectionOverrides = (text: string): string => text.replace(REORDERING, '');
