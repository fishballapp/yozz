/**
 * Dev-only fixture inbox, loaded only when `isDemo()` is true. Every address, message and host is
 * invented; times are offsets from module load.
 */

import type { AddressRecord } from '../lib/addresses';

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

const DEMO_PASSWORD = 'demo-app-password';

import type { Thread } from '../lib/thread';

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
    smtp: {
      host: 'smtp.fastmail.com',
      port: 465,
      username: 'hello@stillwater.example',
      password: DEMO_PASSWORD,
    },
    imap: {
      host: 'imap.fastmail.com',
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

export const THREADS: readonly Thread[] = [
  {
    id: 't-deploy',
    accounts: ['jason@northlane.example'],
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
        at: ago(52 * MINUTE),
        body: [
          'Hey — the main branch build failed at step 14 with exit code 137. That is the OOM kill, so I think the runner ran out of memory again rather than anything in the diff.',
          'It has now happened three times this week and always on the bundle step. Can we bump the runner size before the release on Thursday, or should I split the bundle job instead?',
          'Logs attached. Happy to take it if you are heads-down.',
        ],
        attachments: [
          { name: 'build-4471-step14.log', size: 184_320, kind: 'other' },
          { name: 'runner-metrics.png', size: 96_144, kind: 'image' },
        ],
      },
    ],
  },
  {
    id: 't-stripe',
    accounts: ['jason@northlane.example'],
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
        at: ago(3 * HOUR),
        body: [
          'Your receipt for Acme Workspace (Annual) is attached.',
          'Amount charged: $29.00 to the card ending 4242. Invoice AC-9382, dated today.',
          'Questions about this charge? Just reply to this email.',
        ],
        attachments: [{ name: 'receipt-AC-9382.pdf', size: 42_118, kind: 'pdf' }],
      },
    ],
  },
  {
    id: 't-dune',
    accounts: ['jason@jyu.example'],
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
        at: ago(4 * HOUR),
        // The one fixture with an HTML body.
        hasTextPart: true,
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
    id: 't-mum',
    accounts: ['jason@jyu.example'],
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
    accounts: ['jason@northlane.example'],
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
    accounts: ['jason@northlane.example'],
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
        toAddress: 'noreply@github.com',
        at: ago(1 * DAY + 40 * MINUTE),
        body: [
          'Reviewed and approved. One note left inline about the refresh-token rotation — non-blocking, but worth doing before we forget it exists.',
        ],
      },
    ],
  },
  {
    id: 't-notion',
    accounts: ['jason@jyu.example'],
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
        at: ago(2 * DAY),
        body: [
          'Your workspace had 14 updates this week.',
          'Most active page: Q3 planning board, with 9 edits. You were mentioned twice and have 1 unresolved comment.',
        ],
      },
    ],
  },
  {
    id: 't-vercel',
    accounts: ['jason@northlane.example'],
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
    accounts: ['jason@northlane.example'],
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
    accounts: ['jason@jyu.example'],
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
    accounts: ['jason@jyu.example'],
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
    accounts: ['jason@jyu.example'],
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
        at: ago(5 * DAY),
        body: [
          'Got some good ones of the dog at the beach. The big files are in the drive link below, the attached ones are already resized.',
          'Your mother wants the one with the stick printed for the hallway.',
        ],
        attachments: [
          { name: 'beach-dog-01.jpg', size: 2_411_724, kind: 'image' },
          { name: 'beach-dog-stick.jpg', size: 3_002_112, kind: 'image' },
          { name: 'weekend-originals.zip', size: 48_234_496, kind: 'archive' },
        ],
      },
      {
        id: 'm-dad-2',
        fromName: 'Jason Yu',
        fromAddress: 'jason@jyu.example',
        toAddress: 'dad@jyu.example',
        at: ago(4 * DAY + 20 * HOUR),
        body: ['These are great. I will get the stick one printed this week — A3 or bigger?'],
      },
    ],
  },
  {
    id: 't-cloudflare',
    accounts: ['jason@northlane.example'],
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
    accounts: ['hello@stillwater.example'],
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
        at: ago(9 * HOUR),
        body: [
          'Hi — I bought the pro upgrade on my phone, then tapped restore purchases on my iPad and it charged me a second time.',
          'Order numbers are MT7QK9L2XZ and MT7QM4P8RB. Could you refund the second one? Happy to send screenshots if that helps.',
        ],
      },
    ],
  },
  {
    id: 't-appstore',
    accounts: ['hello@stillwater.example'],
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
    accounts: ['hello@stillwater.example'],
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
    accounts: ['jason@jyu.example'],
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
        at: ago(7 * DAY),
        body: [
          'jyu.example renews in 30 days for $11.06.',
          'Auto-renew is enabled, so no action is needed if you want to keep it.',
        ],
      },
    ],
  },
];
