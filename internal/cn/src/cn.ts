import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Compose conditional Tailwind class strings and dedupe conflicting
// utilities. `clsx` handles the conditional shape (strings, arrays,
// objects); `tailwind-merge` then collapses last-write-wins for
// utilities in the same group (e.g. cn('p-2', 'p-4') → 'p-4',
// cn('bg-card', condition && 'bg-primary') → either depending on
// `condition`).
//
// Works identically in mobile (Uniwind reads the resulting string) and
// the marketing site (Tailwind v4 reads it). Our custom design tokens
// follow standard utility-token naming (e.g. bg-primary-muted,
// text-success) so tailwind-merge's default groupings recognise them
// without config.
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
