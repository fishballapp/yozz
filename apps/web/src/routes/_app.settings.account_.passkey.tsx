import { createFileRoute } from '@tanstack/react-router';
import { SwitchToPasskey } from '../app/settings/SwitchToPasskey';

/** `account_` keeps this page beside Account, not inside it: Account renders no outlet. */
export const Route = createFileRoute('/_app/settings/account_/passkey')({
  staticData: { title: 'Sign-in' },
  component: SwitchToPasskey,
});
