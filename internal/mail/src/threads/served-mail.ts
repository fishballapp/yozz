import { SERVED_MAIL_DATA_ID, type ServedMail } from './frame-scripts.ts';
import { buildMailFrame } from './html.ts';

// The browser script of the page `yozz read --serve-html` serves: one message, sanitised as
// yozz.app sanitises it, with no YOZZ around it, in a frame sandboxed as yozz.app's is. It parses by hand because Zod's
// first parse probes `new Function`, a CSP violation on a page that allows no eval.

/** A hostile mail can claim any height; this bounds the page, and is far past any real mail. */
const MAX_FRAME_HEIGHT_PX = 200_000;

/** The height the frame starts at, as yozz.app's does. */
const FIRST_FRAME_HEIGHT_PX = 160;

const servedMailOf = (): ServedMail => {
  const block = document.getElementById(SERVED_MAIL_DATA_ID);
  const parsed = JSON.parse(block?.textContent ?? '');
  // The raw bytes have no business in the DOM an agent reads once the frame holds the clean ones.
  block?.remove();
  if (typeof parsed?.html !== 'string' || typeof parsed?.allowRemoteImages !== 'boolean') {
    throw new Error('The page holds no mail');
  }
  return parsed;
};

/** Never the raw HTML: the sanitiser is what makes it safe to draw. */
const showFailure = () => {
  const message = document.createElement('p');
  message.textContent = 'This mail could not be shown.';
  document.body.replaceChildren(message);
};

const mail = (() => {
  try {
    const { html, allowRemoteImages } = servedMailOf();
    return buildMailFrame(html, { allowRemoteImages, isReadOnly: true });
  } catch {
    return null;
  }
})();

if (mail === null) {
  showFailure();
} else {
  // Past the end of a short white mail, a dark page would be a band in a screenshot of it.
  if (!mail.isDark) document.documentElement.style.cssText = 'color-scheme:light;background:#fff';
  const frame = document.createElement('iframe');
  frame.title = 'Mail';
  // As `HtmlBody.tsx`: a link opens a tab of its own, and nothing else leaves the frame.
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.height = `${FIRST_FRAME_HEIGHT_PX}px`;
  addEventListener('message', ({ source, data }) => {
    if (source !== frame.contentWindow || data?.type !== 'yozz:mail-height') return;
    const { height } = data;
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return;
    frame.style.height = `${Math.min(Math.ceil(height), MAX_FRAME_HEIGHT_PX)}px`;
  });
  frame.srcdoc = mail.srcdoc;
  document.body.append(frame);
}
