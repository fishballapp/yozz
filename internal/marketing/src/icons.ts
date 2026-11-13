/** One `<link>` to an icon at the site's root: a favicon (`rel: 'icon'`) or the home-screen icon
 * (`rel: 'apple-touch-icon'`). The Layout links a site's list of them (its `icons` prop). */
export type IconLink = {
  rel: 'icon' | 'apple-touch-icon';
  href: string;
  type?: string;
  sizes?: string;
};

/** What the Layout links when a site names no icons: the two files a site keeps in its public/
 * folder. */
export const PUBLIC_ICONS: readonly IconLink[] = [
  { rel: 'icon', type: 'image/png', href: '/favicon.png' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
];
