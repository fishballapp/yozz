import { createFileRoute, Navigate } from '@tanstack/react-router';
import { SwitchToPassword } from '../app/settings/SwitchToPassword';
import { useVault } from '../vault/session';

/**
 * `account_` keeps this page beside Account, not inside it: Account renders no outlet. A password
 * account has nothing to switch to, so a link kept from before a switch lands on Change password.
 */
export const Route = createFileRoute('/_app/settings/account_/switch-to-password')({
  staticData: { title: 'Switch to a password' },
  component: SwitchToPasswordRoute,
});

function SwitchToPasswordRoute() {
  const { session } = useVault();
  if (session?.mode === 'password') {
    return <Navigate to="/settings/account/password" search={previous => previous} replace />;
  }
  return <SwitchToPassword />;
}
