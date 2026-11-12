/**
 * Loaded only when `isDemo()` is true. Every address, message and host is invented; times are
 * offsets from module load.
 */

import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import { MailAutoconfigSchema } from '@yozz.app/vault-contract';
import beachDog from '../../fixtures/attachments/beach-dog-01.jpg?inline';
import beachDogStick from '../../fixtures/attachments/beach-dog-stick.jpg?inline';
import buildLog from '../../fixtures/attachments/build-4471-step14.log?raw';
import receipt from '../../fixtures/attachments/receipt-AC-9382.pdf?inline';
import runnerMetrics from '../../fixtures/attachments/runner-metrics.png?inline';
import type { AutoconfigLookup } from '../addresses/autoconfig';

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

const DEMO_PASSWORD = 'demo-app-password';

import type { ImapMessageSummary } from '@yozz.app/imap';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import type { FolderMatches } from '@yozz.app/mail/threads/found';
import type { FolderWindow } from '@yozz.app/mail/threads/paging';
import type { Attachment, Folder, Thread, ThreadState } from '@yozz.app/mail/threads/thread';
import { formatDate } from '@yozz.app/smtp';

/** Vite inlines a binary sample file as a data URL. */
const bytesOf = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), char => char.charCodeAt(0));

/** A received attachment, carrying its bytes as a fetched body does. */
const sample = (
  name: string,
  mimeType: string,
  kind: Attachment['kind'],
  content: Uint8Array<ArrayBuffer>,
): Attachment => ({ name, size: content.byteLength, kind, mimeType, content });

/** Fixture addresses for demo mode. */
export const DEMO_ADDRESSES: readonly AddressRecord[] = [
  {
    address: 'jason@jyu.example',
    senderName: 'Jason Yu',
    smtp: {
      host: 'smtp.fastmail.com',
      port: 465,
      username: 'jason@jyu.example',
      password: DEMO_PASSWORD,
    },
    imap: {
      host: 'imap.fastmail.com',
      port: 993,
      username: 'jason@jyu.example',
      password: DEMO_PASSWORD,
    },
  },
  {
    address: 'jason@northlane.example',
    senderName: 'Jason Yu',
    smtp: {
      host: 'smtp.gmail.com',
      port: 465,
      username: 'jason@northlane.example',
      password: DEMO_PASSWORD,
    },
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      username: 'jason@northlane.example',
      password: DEMO_PASSWORD,
    },
  },
  {
    address: 'hello@stillwater.example',
    senderName: 'Stillwater',
    // Its mail is unverified, so it offers no "Always from".
    smtp: {
      host: 'smtp.migadu.com',
      port: 465,
      username: 'hello@stillwater.example',
      password: DEMO_PASSWORD,
    },
    imap: {
      host: 'imap.migadu.com',
      port: 993,
      username: 'hello@stillwater.example',
      password: DEMO_PASSWORD,
    },
  },
  {
    address: 'billing@northlane.example',
    senderName: 'Northlane Ltd',
    smtp: {
      host: 'smtp.fastmail.com',
      port: 465,
      username: 'billing@northlane.example',
      password: DEMO_PASSWORD,
    },
  },
  {
    address: 'support@tally.example',
    senderName: 'Tally',
    smtp: {
      host: 'smtp.resend.com',
      port: 587,
      username: 'support@tally.example',
      password: DEMO_PASSWORD,
    },
  },
];

const AUTHORED: readonly Thread[] = [
  {
    id: 't-deploy',
    mailboxes: ['jason@northlane.example'],
    subject: 'Deploy failed on main',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-deploy-1',
        fromName: 'Ana Ferreira',
        fromAddress: 'ana@acme.co',
        toAddress: 'jason@northlane.example',
        to: [{ name: 'Jason Yu', address: 'jason@northlane.example' }],
        cc: [{ name: 'Leo Park', address: 'leo@acme.co' }],
        at: ago(52 * MINUTE),
        body: [
          'Hey — the main branch build failed at step 14 with exit code 137. That is the OOM kill, so I think the runner ran out of memory again rather than anything in the diff.',
          'It has now happened three times this week and always on the bundle step. Can we bump the runner size before the release on Thursday, or should I split the bundle job instead?',
          'Logs attached. Happy to take it if you are heads-down.',
        ],
        attachments: [
          sample(
            'build-4471-step14.log',
            'text/plain',
            'other',
            new TextEncoder().encode(buildLog),
          ),
          sample('runner-metrics.png', 'image/png', 'image', bytesOf(runnerMetrics)),
        ],
      },
    ],
  },
  {
    id: 't-stripe',
    mailboxes: ['jason@northlane.example'],
    subject: 'Your receipt from Acme',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-stripe-1',
        fromName: 'Stripe',
        fromAddress: 'billing@stripe.com',
        toAddress: 'jason@northlane.example',
        // To the billing alias, which forwards here: named in neither To nor Cc.
        to: [{ address: 'billing@northlane.example' }],
        at: ago(3 * HOUR),
        body: [
          'Your receipt for Acme Workspace (Annual) is attached.',
          'Amount charged: $29.00 to the card ending 4242. Invoice AC-9382, dated today.',
          'Questions about this charge? Just reply to this email.',
        ],
        attachments: [sample('receipt-AC-9382.pdf', 'application/pdf', 'pdf', bytesOf(receipt))],
      },
    ],
  },
  {
    id: 't-stripe-september',
    mailboxes: ['jason@northlane.example'],
    subject: 'Your receipt from Acme — September',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-stripe-september-1',
        fromName: 'Stripe',
        fromAddress: 'billing@stripe.com',
        toAddress: 'jason@northlane.example',
        to: [{ address: 'billing@northlane.example' }],
        at: ago(34 * DAY),
        body: [
          'Your receipt for Acme Workspace (Monthly) is attached.',
          'Amount charged: $9.00 to the card ending 4242. Invoice AC-9127.',
        ],
      },
    ],
  },
  {
    id: 't-stripe-trial',
    mailboxes: ['jason@jyu.example'],
    subject: 'Your Stripe test receipt',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-stripe-trial-1',
        fromName: 'Stripe',
        fromAddress: 'receipts@stripe.com',
        toAddress: 'jason@jyu.example',
        to: [{ address: 'jason@jyu.example' }],
        at: ago(6 * DAY),
        body: ['A test receipt from your Stripe dashboard. No card was charged.'],
      },
    ],
  },
  {
    id: 't-dune',
    mailboxes: ['jason@jyu.example'],
    subject: 'Last 24 hours — up to 30% off sleep essentials',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-dune-1',
        fromName: 'Dune & Down',
        fromAddress: 'hello@duneanddown.example',
        toAddress: 'jason@jyu.example',
        to: [{ address: 'jason@jyu.example' }],
        at: ago(4 * HOUR),
        // An HTML body from a sender whose DKIM signature checks out.
        hasTextPart: true,
        htmlSaysMore: true,
        senderCheck: { status: 'verified', signedBy: 'duneanddown.example' },
        body: [
          'Our summer savings end tonight. Save up to 30% on sleep favourites, and spend over £49 for a free pack of tealights.',
        ],
        html: `<div style="margin:0 auto;max-width:560px;font-family:Georgia,serif;color:#1f2430">
  <div style="background:#232946;color:#fffffe;padding:32px 24px;text-align:center">
    <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase">Last 24 hours</p>
    <h1 style="margin:8px 0 0;font-size:32px">Sale ends soon</h1>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.6">Our summer savings are almost over. This is your final 24 hours to save up to 30% on sleep favourites.</p>
    <p style="margin:24px 0 0"><a href="https://duneanddown.example/sale" style="display:inline-block;background:#eebbc3;color:#232946;padding:12px 28px;text-decoration:none;font-size:13px;letter-spacing:1px">SHOP SALE</a></p>
  </div>
  <div style="padding:28px 24px">
    <h2 style="margin:0;font-size:20px;color:#232946;text-align:center">Last chance to save up to 30%</h2>
    <img src="https://duneanddown.example/img/pillow.jpg" alt="The Adjustable Pillow" width="512" style="width:100%;margin-top:20px">
    <h3 style="margin:20px 0 4px;font-size:16px">Adjustable Pillow</h3>
    <p style="margin:0;font-size:14px"><s style="color:#8a8f98">£45.00</s> <strong>£40.50</strong> · ★★★★★ 4.8/5</p>
    <ul style="margin:12px 0 0;padding-left:18px;font-size:14px;line-height:1.7">
      <li>Adjustable: 3 heights and 2 depths.</li>
      <li>Customise in seconds.</li>
      <li>One size fits all.</li>
    </ul>
    <p style="margin:20px 0 0"><a href="https://duneanddown.example/pillow" style="color:#232946">Shop now →</a></p>
  </div>
</div>`,
      },
    ],
  },
  {
    id: 't-hollis',
    mailboxes: ['jason@northlane.example'],
    subject: 'Your beans ship tomorrow',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-hollis-1',
        fromName: 'Hollis Coffee Roasters',
        fromAddress: 'orders@hollisroasters.example',
        toAddress: 'jason@northlane.example',
        to: [{ address: 'jason@northlane.example' }],
        at: ago(4 * HOUR + 40 * MINUTE),
        // Sent through a mailing service whose signature is not the shop's own domain.
        hasTextPart: true,
        htmlSaysMore: true,
        senderCheck: { status: 'unverified' },
        // A mailing service that takes unsubscribes by mail only.
        unsubscribe: {
          mailto:
            'mailto:u-93b2e1@lists.hollisroasters.example?subject=Unsubscribe&body=Please%20remove%20me%20from%20this%20list.',
        },
        body: [
          'Order #H-20931 is roasted and packed. 250 g Kiambu AA, whole bean, ships tomorrow by Royal Mail Tracked 48.',
        ],
        html: `<div style="margin:0 auto;max-width:520px;font-family:Helvetica,Arial,sans-serif;color:#2b2118">
  <img src="https://hollisroasters.example/email/header.png" alt="Hollis Coffee Roasters" width="520" height="120" style="width:100%;height:auto">
  <div style="padding:24px">
    <h1 style="margin:0;font-size:22px">Roasted, packed, ready to go</h1>
    <p style="margin:12px 0 0;font-size:14px;line-height:1.6">Order #H-20931 left the roaster this morning and ships tomorrow by Royal Mail Tracked 48.</p>
    <table style="margin-top:20px;width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:8px 0;border-top:1px solid #e6dccf">Kiambu AA · 250 g · whole bean</td><td style="padding:8px 0;border-top:1px solid #e6dccf;text-align:right">£11.50</td></tr>
      <tr><td style="padding:8px 0;border-top:1px solid #e6dccf">Shipping</td><td style="padding:8px 0;border-top:1px solid #e6dccf;text-align:right">£3.20</td></tr>
    </table>
    <p style="margin:20px 0 0;font-size:13px;color:#6b5d50">Rest the beans four days after roasting for the best cup.</p>
  </div>
</div>`,
      },
    ],
  },
  {
    id: 't-mum',
    mailboxes: ['jason@jyu.example'],
    subject: 'Sunday lunch?',
    isUnread: true,
    isReplied: false,
    isStarred: true,
    messages: [
      {
        id: 'm-mum-1',
        fromName: 'Mum',
        fromAddress: 'mum@jyu.example',
        toAddress: 'jason@jyu.example',
        to: [
          { name: 'Jason Yu', address: 'jason@jyu.example' },
          { name: 'Dad', address: 'dad@jyu.example' },
          { name: 'Mei Yu', address: 'mei.yu@gmail.com' },
          { name: 'Ollie Yu', address: 'ollie@yu-family.example' },
          { name: 'Grandma Lin', address: 'lin.huiying@outlook.example' },
          { name: 'Auntie Wen', address: 'wen.chan@outlook.example' },
        ],
        at: ago(5 * HOUR),
        body: [
          'Are you free around one o’clock on Sunday? I am doing the roast and your dad has been asking when you are next over.',
          'Bring washing if you have any. And do not eat before you come, last time you turned up full.',
        ],
      },
    ],
  },
  {
    id: 't-linear',
    mailboxes: ['jason@northlane.example'],
    subject: '3 issues assigned to you',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-linear-1',
        fromName: 'Linear',
        fromAddress: 'notifications@linear.app',
        toAddress: 'jason@northlane.example',
        to: [{ name: 'Jason Yu', address: 'jason@northlane.example' }],
        at: ago(5 * HOUR + 20 * MINUTE),
        body: [
          'Three issues were assigned to you in the last day.',
          'FIS-412 API rate limiting returns 429 without Retry-After. FIS-418 Dashboard chart drops the last bucket. FIS-421 Mobile login flow loses the redirect after OAuth.',
          'Open them in Linear to triage.',
        ],
      },
    ],
  },
  {
    id: 't-github',
    mailboxes: ['jason@northlane.example'],
    subject: 'PR #204 ready for review',
    isUnread: false,
    isReplied: true,
    isStarred: false,
    messages: [
      {
        id: 'm-github-1',
        fromName: 'GitHub',
        fromAddress: 'noreply@github.com',
        toAddress: 'jason@northlane.example',
        // GitHub's own shape: the repository in To, you and the reason in Cc.
        to: [{ name: 'northlane/web', address: 'web@noreply.github.com' }],
        cc: [
          { name: 'Jason Yu', address: 'jason@northlane.example' },
          { name: 'Review requested', address: 'review_requested@noreply.github.com' },
        ],
        // Answers go to the pull request, not to noreply.
        replyTo: [{ name: 'northlane/web', address: 'reply+AAB7XQ4M@reply.github.com' }],
        at: ago(1 * DAY + 2 * HOUR),
        body: [
          'ana-f opened pull request #204: Rewrite auth middleware to drop the session table.',
          'Two approvals are required before this can merge into main. 14 files changed, 402 additions, 331 deletions.',
        ],
      },
      {
        id: 'm-github-2',
        fromName: 'Jason Yu',
        fromAddress: 'jason@northlane.example',
        toAddress: 'reply+AAB7XQ4M@reply.github.com',
        to: [{ name: 'northlane/web', address: 'reply+AAB7XQ4M@reply.github.com' }],
        at: ago(1 * DAY + 40 * MINUTE),
        body: [
          'Reviewed and approved. One note left inline about the refresh-token rotation — non-blocking, but worth doing before we forget it exists.',
        ],
      },
    ],
  },
  {
    id: 't-notion',
    mailboxes: ['jason@jyu.example'],
    subject: 'Weekly digest',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-notion-1',
        fromName: 'Notion',
        fromAddress: 'digest@notion.so',
        toAddress: 'jason@jyu.example',
        to: [{ address: 'jason@jyu.example' }],
        at: ago(2 * DAY),
        // Both forms offered: the link wins, being the fewest steps.
        unsubscribe: {
          https: 'https://notion.example/email/unsubscribe?u=4f1c9a',
          mailto: 'mailto:unsubscribe@notion.example?subject=unsubscribe',
        },
        body: [
          'Your workspace had 14 updates this week.',
          'Most active page: Q3 planning board, with 9 edits. You were mentioned twice and have 1 unresolved comment.',
        ],
      },
    ],
  },
  {
    id: 't-vercel',
    mailboxes: ['jason@northlane.example'],
    subject: 'Build succeeded for yozz-web',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-vercel-1',
        fromName: 'Vercel',
        fromAddress: 'notifications@vercel.com',
        toAddress: 'jason@northlane.example',
        to: [{ name: 'Jason Yu', address: 'jason@northlane.example' }],
        at: ago(2 * DAY + 3 * HOUR),
        body: [
          'Production deployment for yozz-web finished in 47 seconds.',
          'Commit 5548771 — fix(deps): keep @better-auth/core to a single copy. No build warnings.',
          'Inspect the deployment at https://vercel.com/northlane/yozz-web/deployments — the preview is live at www.yozz-web-preview.vercel.app.',
        ],
      },
    ],
  },
  {
    id: 't-kate',
    mailboxes: ['jason@northlane.example'],
    subject: 'Contract for review',
    isUnread: true,
    isReplied: false,
    isStarred: true,
    messages: [
      {
        id: 'm-kate-1',
        fromName: 'Kate Lai',
        fromAddress: 'kate@contractlaw.co',
        toAddress: 'jason@northlane.example',
        to: [{ name: 'Jason Yu', address: 'jason@northlane.example' }],
        cc: [
          { name: 'Sofia Mendes', address: 'sofia@contractlaw.co' },
          { name: 'Northlane Billing', address: 'billing@northlane.example' },
        ],
        at: ago(3 * DAY),
        body: [
          'Please find the revised contract attached, with the new payment schedule and clause 7.3 updated per our call on Tuesday.',
          'Could you review the deliverables section in particular and let me know if the timeline still works on your end? I will need a signature on pages 7 and 12.',
          'Happy to hop on a quick call tomorrow morning if it is easier than a redline.',
        ],
        attachments: [
          { name: 'northlane-services-agreement-v4.pdf', size: 1_248_576, kind: 'pdf' },
          { name: 'schedule-of-fees.xlsx', size: 31_744, kind: 'sheet' },
        ],
      },
    ],
  },
  {
    id: 't-fastmail',
    mailboxes: ['jason@jyu.example'],
    subject: 'Password changed',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-fastmail-1',
        fromName: 'Fastmail',
        fromAddress: 'security@fastmail.com',
        toAddress: 'jason@jyu.example',
        to: [{ name: 'Jason Yu', address: 'jason@jyu.example' }],
        at: ago(4 * DAY),
        body: [
          'The password on your account was changed from a new device in London, United Kingdom.',
          'If this was not you, reset your password immediately and review your active sessions.',
        ],
      },
    ],
  },
  {
    id: 't-hn',
    mailboxes: ['jason@jyu.example'],
    subject: 'Top stories today',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-hn-1',
        fromName: 'Hacker Newsletter',
        fromAddress: 'mail@hackernewsletter.com',
        toAddress: 'jason@jyu.example',
        // Sent to the list by Bcc, so the sender's own address stands in To.
        to: [{ name: 'Hacker Newsletter', address: 'mail@hackernewsletter.com' }],
        at: ago(4 * DAY + 6 * HOUR),
        body: [
          'The ten highest scoring stories from the last 24 hours.',
          'Including a long read on why IMAP survived everything that was meant to replace it, and a teardown of a split-flap display controller.',
        ],
      },
    ],
  },
  {
    id: 't-dad',
    mailboxes: ['jason@jyu.example'],
    subject: 'Photos from the weekend',
    isUnread: false,
    isReplied: true,
    isStarred: false,
    messages: [
      {
        id: 'm-dad-1',
        fromName: 'Dad',
        fromAddress: 'dad@jyu.example',
        toAddress: 'jason@jyu.example',
        to: [
          { name: 'Jason', address: 'jason@jyu.example' },
          { name: 'Mei', address: 'mei.yu@gmail.com' },
        ],
        at: ago(5 * DAY),
        body: [
          'Got some good ones of the dog at the beach. The big files are in the drive link below, the attached ones are already resized.',
          'Your mother wants the one with the stick printed for the hallway.',
        ],
        attachments: [
          sample('beach-dog-01.jpg', 'image/jpeg', 'image', bytesOf(beachDog)),
          // As many phone clients send every attachment: a generic label, so the kind is `other`
          // and the extension and the bytes are what make it an image.
          sample(
            'beach-dog-stick.jpg',
            'application/octet-stream',
            'other',
            bytesOf(beachDogStick),
          ),
          { name: 'weekend-originals.zip', size: 48_234_496, kind: 'archive' },
        ],
      },
      {
        id: 'm-dad-2',
        fromName: 'Jason Yu',
        fromAddress: 'jason@jyu.example',
        toAddress: 'dad@jyu.example',
        to: [{ name: 'Dad', address: 'dad@jyu.example' }],
        cc: [{ name: 'Mei', address: 'mei.yu@gmail.com' }],
        at: ago(4 * DAY + 20 * HOUR),
        body: ['These are great. I will get the stick one printed this week — A3 or bigger?'],
      },
    ],
  },
  {
    id: 't-cloudflare',
    mailboxes: ['jason@northlane.example'],
    subject: 'Zone yozz.app is active',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-cf-1',
        fromName: 'Cloudflare',
        fromAddress: 'noreply@notify.cloudflare.com',
        toAddress: 'jason@northlane.example',
        to: [{ address: 'jason@northlane.example' }],
        at: ago(6 * DAY),
        body: [
          'Your zone yozz.app is now active on Cloudflare.',
          'Nameservers have been updated and DNS is serving. SSL/TLS is set to Full (strict) and the universal certificate has been issued.',
          'Manage the zone at https://dash.cloudflare.com/zones/yozz.app or reply to support@notify.cloudflare.com if something looks wrong.',
        ],
      },
    ],
  },
  {
    id: 't-support-refund',
    mailboxes: ['hello@stillwater.example'],
    subject: 'Refund request — bought twice by mistake',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-support-1',
        fromName: 'Priya Nandakumar',
        fromAddress: 'priya.n@gmail.com',
        toAddress: 'hello@stillwater.example',
        to: [{ name: 'Stillwater', address: 'hello@stillwater.example' }],
        at: ago(9 * HOUR),
        body: [
          'Hi — I bought the pro upgrade on my phone, then tapped restore purchases on my iPad and it charged me a second time.',
          'Order numbers are MT7QK9L2XZ and MT7QM4P8RB. Could you refund the second one? Happy to send screenshots if that helps.',
        ],
      },
    ],
  },
  {
    id: 't-indie-monday',
    mailboxes: ['hello@stillwater.example'],
    subject: 'Issue #212 — the pricing page nobody reads',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-indie-monday-1',
        fromName: 'Indie Dev Monday',
        fromAddress: 'hello@indiedevmonday.example',
        toAddress: 'hello@stillwater.example',
        to: [{ address: 'hello@stillwater.example' }],
        at: ago(14 * HOUR),
        hasTextPart: true,
        htmlSaysMore: true,
        senderCheck: { status: 'unverified' },
        body: [
          'This week: why most visitors skip your pricing page, three founders on charging from day one, and a tool for screenshotting App Store listings.',
        ],
        html: `<div style="margin:0 auto;max-width:560px;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <img src="https://indiedevmonday.example/banner/212.png" alt="Indie Dev Monday #212" width="560" height="140" style="width:100%;height:auto">
  <div style="padding:20px 24px">
    <h1 style="margin:0;font-size:24px">The pricing page nobody reads</h1>
    <p style="margin:12px 0 0;font-size:15px;line-height:1.6">Most visitors never scroll past the first plan. Three founders on what they put above the fold instead, and what it did to trials.</p>
    <p style="margin:20px 0 0;font-size:15px;line-height:1.6"><strong>Also this week:</strong> charging from day one, a tidy way to screenshot App Store listings, and a launch checklist that fits on a postcard.</p>
    <p style="margin:20px 0 0"><a href="https://indiedevmonday.example/212" style="color:#4b3fd1">Read the issue →</a></p>
  </div>
</div>`,
      },
    ],
  },
  {
    id: 't-appstore',
    mailboxes: ['hello@stillwater.example'],
    subject: 'Your app status changed to Ready for Sale',
    isUnread: false,
    isReplied: false,
    isStarred: true,
    messages: [
      {
        id: 'm-appstore-1',
        fromName: 'App Store Connect',
        fromAddress: 'no_reply@email.apple.com',
        toAddress: 'hello@stillwater.example',
        to: [{ address: 'hello@stillwater.example' }],
        at: ago(1 * DAY + 8 * HOUR),
        body: [
          'The status for stillwater 1.4.0 has changed to Ready for Sale.',
          'The version is now available in 175 regions. It took 14 hours in review.',
        ],
      },
    ],
  },
  {
    id: 't-feedback',
    mailboxes: ['hello@stillwater.example'],
    subject: 'Feature request: recurring shuffles',
    isUnread: false,
    isReplied: true,
    isStarred: false,
    messages: [
      {
        id: 'm-feedback-1',
        fromName: 'Tom Beckett',
        fromAddress: 'tom@beckett.dev',
        toAddress: 'hello@stillwater.example',
        to: [{ name: 'Stillwater', address: 'hello@stillwater.example' }],
        at: ago(3 * DAY + 5 * HOUR),
        body: [
          'Love the app. One thing I keep wanting: the same list reshuffled every morning without me opening it.',
          'Right now I reshuffle manually at about 8am every day, which rather defeats the point of not having to think about it.',
        ],
      },
      {
        id: 'm-feedback-2',
        fromName: 'stillwater',
        fromAddress: 'hello@stillwater.example',
        toAddress: 'tom@beckett.dev',
        to: [{ name: 'Tom Beckett', address: 'tom@beckett.dev' }],
        at: ago(3 * DAY + 2 * HOUR),
        body: [
          'Thanks Tom — that is the most requested thing by a distance, and it is on the list for the next release.',
          'Out of interest: would you want a notification when it reshuffles, or just to find it done when you open the app?',
        ],
      },
    ],
  },
  {
    id: 't-domain',
    mailboxes: ['jason@jyu.example'],
    subject: 'Renewal reminder for jyu.example',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-domain-1',
        fromName: 'Porkbun',
        fromAddress: 'support@porkbun.com',
        toAddress: 'jason@jyu.example',
        to: [{ name: 'Jason Yu', address: 'jason@jyu.example' }],
        at: ago(7 * DAY),
        body: [
          'jyu.example renews in 30 days for $11.06.',
          'Auto-renew is enabled, so no action is needed if you want to keep it.',
        ],
      },
    ],
  },
  // What the providers filed as spam, and one real message they got wrong.
  {
    id: 't-junk-invoice',
    mailboxes: ['jason@northlane.example'],
    subject: 'RE: Invoice INV-20931 overdue — final notice',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-junk-invoice-1',
        fromName: 'Accounts Receivable',
        fromAddress: 'ar-dept@payables-notice.example',
        toAddress: 'jason@northlane.example',
        to: [{ address: 'jason@northlane.example' }],
        at: ago(3 * HOUR),
        body: [
          'Dear customer, your invoice INV-20931 for $4,812.00 is now 14 days overdue.',
          'To avoid suspension of services, review the attached statement and settle the balance through the secure portal within 24 hours.',
        ],
      },
    ],
  },
  {
    id: 't-junk-storage',
    mailboxes: ['jason@jyu.example'],
    subject: 'Your mailbox is 98% full — action required',
    isUnread: true,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-junk-storage-1',
        fromName: 'Mail Administrator',
        fromAddress: 'no-reply@mailbox-quota.example',
        toAddress: 'jason@jyu.example',
        to: [{ address: 'jason@jyu.example' }],
        at: ago(9 * HOUR),
        body: [
          'Your mailbox has reached 98% of its storage limit. Incoming messages will be held until you verify your account.',
          'Verify now to keep receiving mail. This link expires in 12 hours.',
        ],
      },
    ],
  },
  {
    id: 't-junk-residents',
    mailboxes: ['jason@jyu.example'],
    subject: "Minutes from Thursday's residents' meeting",
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-junk-residents-1',
        fromName: 'Priya Nair',
        fromAddress: 'priya@hollisroad.example',
        toAddress: 'jason@jyu.example',
        to: [{ name: 'Hollis Road residents', address: 'residents@hollisroad.example' }],
        at: ago(2 * DAY),
        body: [
          'Hi all — minutes from Thursday are below. The short version: the bin store gets a new lock on the 14th, and the gardening rota starts next month.',
          'If you want a key for the bin store, reply to me by Friday and I will get one cut for you.',
        ],
      },
    ],
  },
  {
    id: 't-junk-giftcard',
    mailboxes: ['hello@stillwater.example'],
    subject: 'Congratulations! You were selected for a $500 gift card',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages: [
      {
        id: 'm-junk-giftcard-1',
        fromName: 'Customer Rewards',
        fromAddress: 'rewards@winner-survey.example',
        toAddress: 'hello@stillwater.example',
        to: [{ address: 'hello@stillwater.example' }],
        at: ago(4 * DAY),
        body: [
          'You have been chosen to take part in our two-minute customer survey. Complete it today and claim a $500 gift card.',
          'Only 3 rewards remain in your area.',
        ],
      },
    ],
  },
];

/** Conversations already filed away, so Archive, Trash, Junk and a search across them have something to show. */
const FILED_AWAY: Readonly<Record<string, Folder>> = {
  't-fastmail': 'archive',
  't-cloudflare': 'archive',
  't-hn': 'archive',
  't-stripe-september': 'archive',
  't-dune': 'trash',
  't-stripe-trial': 'trash',
  't-junk-invoice': 'junk',
  't-junk-storage': 'junk',
  't-junk-residents': 'junk',
  't-junk-giftcard': 'junk',
};

/**
 * One copy per message: in the sending mailbox's Sent when it is yours, else in the inbox it landed
 * in, or wherever `FILED_AWAY` moved the conversation. Trash takes the Sent copies too.
 */
const filed = (thread: Thread): ThreadState => {
  const away = FILED_AWAY[thread.id];
  const messages = thread.messages.map((message, index) => {
    const isOwn = thread.mailboxes.includes(message.fromAddress);
    const folder: Folder = (() => {
      if (isOwn) return away === 'trash' ? 'trash' : 'sent';
      return away ?? 'inbox';
    })();
    const location = {
      mailbox: isOwn ? message.fromAddress : message.toAddress,
      folder,
      uidValidity: 1,
      uid: index + 1,
    };
    return { ...message, locations: [location] };
  });
  const locations = messages.flatMap(message => message.locations);
  return {
    ...thread,
    messages,
    folders: [...new Set(locations.map(({ folder }) => folder))],
    foldersByMailbox: Object.fromEntries(
      thread.mailboxes.map(mailbox => [
        mailbox,
        [
          ...new Set(
            locations.filter(copy => copy.mailbox === mailbox).map(({ folder }) => folder),
          ),
        ],
      ]),
    ),
  };
};

export const THREADS: readonly ThreadState[] = AUTHORED.map(filed);

/** Older mail than the demo's windows reach, so a list across folders offers Older mail. */
export const DEMO_WINDOWS: readonly FolderWindow[] = [
  {
    mailbox: 'jason@northlane.example',
    folder: 'archive',
    isComplete: false,
    summaries: [
      {
        seq: 1,
        uid: 1,
        flags: ['\\Seen'],
        internalDate: '01-Jan-2020 00:00:00 +0000',
        size: 1000,
        envelope: null,
        references: [],
        gmailThreadId: null,
        attachmentNames: [],
      },
    ],
  },
];

const foundReceipt = (uid: number, month: string, daysAgo: number): ImapMessageSummary => {
  const sent = formatDate(
    Temporal.Instant.fromEpochMilliseconds(ago(daysAgo * DAY)).toZonedDateTimeISO('UTC'),
  );
  return {
    seq: uid,
    uid,
    flags: ['\\Seen'],
    internalDate: sent,
    size: 4000,
    envelope: {
      date: sent,
      subject: `Your receipt from Acme — ${month}`,
      subjectRaw: null,
      from: [{ name: 'Stripe', mailbox: 'billing', host: 'stripe.com' }],
      sender: [],
      replyTo: [],
      to: [{ name: null, mailbox: 'jason', host: 'northlane.example' }],
      cc: [],
      bcc: [],
      inReplyTo: null,
      messageId: `<found-${uid}@stripe.com>`,
    },
    references: [],
    gmailThreadId: null,
    attachmentNames: [],
  };
};

/**
 * Stands in for the servers, so a search's states can be seen. `yozz:demo-search` picks one:
 * `hang` never answers, `fail` fails one address, `more` names older matches than it reads.
 */
export const demoServerSearch = async (
  address: string,
  words: readonly string[],
  signal: AbortSignal,
  onMatches: (matches: FolderMatches) => void,
): Promise<Result<null, MailConnectionFailure>> => {
  const mode = localStorage.getItem('yozz:demo-search');
  const cancelled = { ok: false, error: { kind: 'cancelled' } } as const;
  if (mode === 'hang') {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return cancelled;
  }
  await new Promise(resolve => setTimeout(resolve, 800));
  if (signal.aborted) return cancelled;
  if (mode === 'fail' && address === 'hello@stillwater.example') {
    return { ok: false, error: { kind: 'stalled' } };
  }
  const isReceipt = words.some(word => /receipt|stripe/iu.test(word));
  if (address === 'jason@northlane.example' && isReceipt) {
    const summaries = [
      foundReceipt(9001, 'March', 240),
      foundReceipt(9002, 'February', 270),
      foundReceipt(9003, 'January', 300),
    ];
    onMatches({
      folder: 'archive',
      uidValidity: 1,
      hits: summaries.map(({ uid }) => uid),
      summaries,
      folderName: 'Archive',
      rest: mode === 'more' ? [8999, 8998] : [],
      reachedAt: mode === 'more' ? ago(300 * DAY) : null,
    });
  }
  return { ok: true, value: null };
};

/** The next page a `more` search named. */
export const demoMoreMatches = async (
  previous: FolderMatches,
): Promise<Result<FolderMatches, MailConnectionFailure>> => {
  await new Promise(resolve => setTimeout(resolve, 800));
  return {
    ok: true,
    value: {
      ...previous,
      hits: previous.rest,
      summaries: [foundReceipt(8999, 'December', 330), foundReceipt(8998, 'November', 360)],
      rest: [],
      reachedAt: null,
    },
  };
};

/**
 * Demo mode's server lookup. A `.example` domain with a Fastmail fixture address answers with that
 * address's servers, as a provider that publishes them would; any other domain answers unavailable.
 */
export const demoAutoconfig = (domain: string): AutoconfigLookup => {
  const fastmail = DEMO_ADDRESSES.find(
    record =>
      record.address.endsWith(`@${domain}`) &&
      record.imap?.host === 'imap.fastmail.com' &&
      record.smtp.host === 'smtp.fastmail.com',
  );
  if (!domain.endsWith('.example') || fastmail === undefined) return { status: 'unavailable' };
  // Parsed, so the fixture obeys the same contract as a real answer (implicit TLS ports only).
  return {
    status: 'found',
    config: MailAutoconfigSchema.parse({
      imap: fastmail.imap ? { host: fastmail.imap.host, port: fastmail.imap.port } : null,
      smtp: { host: fastmail.smtp.host, port: fastmail.smtp.port },
      username: 'address',
      source: 'provider',
      sourceDomain: domain,
    }),
  };
};
