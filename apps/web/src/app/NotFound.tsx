import { Link } from '@tanstack/react-router';
import { buttonClass } from '../ui/Button';

export const NotFound = () => (
  <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-ink px-6 text-center">
    <p className="font-mono text-2xs tracking-[0.14em] text-paper-faint uppercase">404</p>
    <p className="text-base text-paper-dim">This page doesn't exist.</p>
    <Link
      to="/m/$view"
      params={{ view: 'unified' }}
      search={{}}
      className={buttonClass({ variant: 'primary' })}
    >
      Back to mail
    </Link>
  </div>
);
