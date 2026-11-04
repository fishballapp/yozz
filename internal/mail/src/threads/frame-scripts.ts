// What runs inside a mail frame, with no dependencies, so the CLI's server can hash it in Node
// without importing DOMPurify.

/** Marks an image consent can restore, which is what the click script reads. */
export const WITHHELD_IMAGE_ATTR = 'data-yozz-withheld';

/** Tells the host how tall the mail is. */
export const MAIL_FRAME_MEASURE_SCRIPT = `let pending=0,last=-1;
const post=()=>{pending=0;const height=document.documentElement.scrollHeight;if(height===last)return;last=height;parent.postMessage({type:'yozz:mail-height',height},'*')};
const schedule=()=>{if(pending===0)pending=setTimeout(post,100)};
new ResizeObserver(schedule).observe(document.body);
addEventListener('load',schedule);`;

// The first click on a withheld image loads it without following its link. This exact source is
// also admitted by the host CSP's SHA-256 in `_headers`: a srcdoc inherits the host policy, then
// applies its own nonce policy, so a drift in either fails.
export const MAIL_FRAME_CLICKABLE_SCRIPT = `${MAIL_FRAME_MEASURE_SCRIPT}
addEventListener('click',e=>{if(!(e.target instanceof HTMLImageElement&&e.target.hasAttribute('${WITHHELD_IMAGE_ATTR}')))return;e.preventDefault();parent.postMessage({type:'yozz:load-remote-images'},'*')});`;

/** The `id` of the data block a served mail's page reads. */
export const SERVED_MAIL_DATA_ID = 'mail';

/** What the data block holds. */
export type ServedMail = {
  readonly html: string;
  readonly allowRemoteImages: boolean;
};
