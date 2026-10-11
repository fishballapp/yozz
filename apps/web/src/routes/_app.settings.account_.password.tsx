import { createFileRoute } from '@tanstack/react-router';
import { ChangePassword } from '../app/settings/ChangePassword';
import { SwitchToPassword } from '../app/settings/SwitchToPassword';
import { useVault } from '../vault/session';

/** `account_` keeps this page beside Account, not inside it: Account renders no outlet. */
export const Route = createFileRoute('/_app/settings/account_/password')({
  staticData: { title: 'Sign-in' },
  component: PasswordRoute,
});

/** A password account changes its password; a passkey account switches to one. */
function PasswordRoute() {
  const { session } = useVault();
  return session?.mode === 'password' ? <ChangePassword /> : <SwitchToPassword />;
}
