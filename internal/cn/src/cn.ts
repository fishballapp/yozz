import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// `clsx` handles the conditional shape; `tailwind-merge` then collapses conflicting utilities
// last-write-wins (`cn('p-2', 'p-4')` → `'p-4'`). Custom tokens follow standard utility naming so
// tailwind-merge's default groupings recognise them.
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
