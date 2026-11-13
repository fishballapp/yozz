import { createFileRoute, Navigate } from '@tanstack/react-router';
import { ChangePassword } from '../app/settings/ChangePassword';
import { useVault } from '../vault/session';

/**
 * `account_` keeps this page beside Account, not inside it: Account renders no outlet. A passkey
 * account has no password to change, so a link kept from before a switch lands on the page it now
 * means.
 */
export const Route = createFileRoute('/_app/settings/account_/password')({
  staticData: { title: 'Change password' },
  component: ChangePasswordRoute,
});

function ChangePasswordRoute() {
  const { session } = useVault();
  if (session?.mode === 'passkey') {
    return (
      <Navigate to="/settings/account/switch-to-password" search={previous => previous} replace />
    );
  }
  return <ChangePassword />;
}
