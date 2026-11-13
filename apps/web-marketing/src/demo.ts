/**
 * The invented mail the page draws the app with. Every name, address and message is demo data,
 * and every drawing that shows it says so in its caption (PRODUCT.md, "Evidence on Hand").
 */

/** An address as the app holds it: one SMTP server each, and an inbox unless it is send-only. */
export type DemoAddress = {
  address: string;
  smtpHost: string;
  /** Unread in its inbox; `null` for a send-only address, which has no inbox. */
  unread: number | null;
  /** How a reply from it is signed in the composer drawing. */
  signature: string;
};

export const ADDRESSES: readonly DemoAddress[] = [
  { address: 'ada@postbox.example', smtpHost: 'smtp.postbox.example', unread: 1, signature: 'Ada' },
  {
    address: 'ada@northlane.example',
    smtpHost: 'mail.northlane.example',
    unread: 3,
    signature: 'Ada',
  },
  {
    address: 'hello@stillwater.example',
    smtpHost: 'smtp.stillwater.example',
    unread: 0,
    signature: 'Ada, Stillwater',
  },
  {
    address: 'orders@stillwater.example',
    smtpHost: 'smtp.stillwater.example',
    unread: null,
    signature: 'Stillwater orders',
  },
];

/** The address the open message arrived at, and the composer's From when the page loads. */
export const REPLYING_FROM = 'hello@stillwater.example';

/** One row of the unified list. `account` is the label of the address it arrived at. */
export type DemoThread = {
  from: string;
  subject: string;
  snippet: string;
  account: 'postbox' | 'northlane' | 'stillwater';
  time: string;
  messageCount?: number;
  isUnread?: boolean;
  isStarred?: boolean;
  hasAttachment?: boolean;
};

export const THREADS: readonly DemoThread[] = [
  {
    from: 'Kate Lai',
    subject: 'Catalogue proofs',
    snippet: 'The printer sent the second round this morning, and the cover is much closer',
    account: 'stillwater',
    time: '52m',
    isStarred: true,
    hasAttachment: true,
  },
  {
    from: 'Northlane Payroll',
    subject: 'Your payslip is ready',
    snippet: 'Sign in to the staff portal to view it',
    account: 'northlane',
    time: '3h',
    isUnread: true,
  },
  {
    from: 'Mum',
    subject: 'Sunday lunch?',
    snippet: 'Are you free around one? Your aunt is coming over',
    account: 'postbox',
    time: '4h',
    isUnread: true,
    isStarred: true,
  },
  {
    from: 'Tom Beckett',
    subject: 'Re: Wholesale order for the shop',
    snippet: 'Forty units works for us. Can you invoice',
    account: 'stillwater',
    time: '5h',
    messageCount: 2,
  },
  {
    from: 'Priya Nandakumar',
    subject: 'Standup notes and Thursday’s release',
    snippet: 'Three things from this morning',
    account: 'northlane',
    time: '9h',
    isUnread: true,
  },
  {
    from: 'Harbour Print Co.',
    subject: 'Invoice 0412',
    snippet: 'Thank you for your order. Payment is due in 30 days',
    account: 'stillwater',
    time: 'Tue',
    hasAttachment: true,
  },
  {
    from: 'Climbing Club',
    subject: 'Rota for November',
    snippet: 'We still need two belayers for the 21st',
    account: 'postbox',
    time: 'Tue',
  },
  {
    from: 'Ana Ferreira',
    subject: 'Can you review the migration plan?',
    snippet: 'It is two pages. I would like to start Monday',
    account: 'northlane',
    time: 'Mon',
    isUnread: true,
  },
  {
    from: 'Dad',
    subject: 'Photos from the weekend',
    snippet: 'The ones from the harbour came out well',
    account: 'postbox',
    time: 'Mon',
    messageCount: 3,
    isStarred: true,
    hasAttachment: true,
  },
  {
    from: 'Domain Desk',
    subject: 'stillwater.example renews in 30 days',
    snippet: 'No action is needed if auto-renew is on',
    account: 'stillwater',
    time: 'Sun',
  },
  {
    from: 'Jonas Weber',
    subject: 'Re: Table for six on the 21st',
    snippet: 'Booked for half seven',
    account: 'postbox',
    time: 'Sun',
  },
  {
    from: 'Northlane IT',
    subject: 'Scheduled maintenance, Friday 22:00',
    snippet: 'The VPN will be down for about an hour',
    account: 'northlane',
    time: 'Sat',
  },
  {
    from: 'Mei Yu',
    subject: 'Thank you for the parcel',
    snippet: 'It arrived on Thursday, all in one piece',
    account: 'stillwater',
    time: 'Sat',
  },
  {
    from: 'Eastside Library',
    subject: 'Two books are due next week',
    snippet: 'You can renew them online',
    account: 'postbox',
    time: '6 Nov',
  },
];

/** The conversation open in the reader: the first row. */
export const OPEN_MESSAGE = {
  subject: 'Catalogue proofs',
  fromName: 'Kate Lai',
  fromAddress: 'kate@lai-studio.example',
  date: 'Today, 09:12',
  paragraphs: [
    'The printer sent the second round this morning, and the cover is much closer. The green is still a touch cold on page four, so I have asked for one more pass on that spread only.',
    'Could you look at the two cover options before Monday? Option B has the wider margin we talked about.',
    'Kate',
  ],
  attachments: [
    { kind: 'PDF', name: 'catalogue-proof-v2.pdf', size: '2.4 MB' },
    { kind: 'IMG', name: 'cover-option-b.png', size: '310 KB' },
  ],
} as const;
