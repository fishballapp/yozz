import { Navigate } from '@tanstack/react-router';
import { keepCompose } from '../../compose/intent';
import { useMail } from '../../store/MailProvider';
import { useMediaQuery } from '../../ui/chrome';
import { byRole } from '../Settings';
import { AddAddress } from './AddAddress';

/**
 * `/settings` is the list on a phone, where this pane is hidden. From `lg` it opens the first address
 * in the list's own order: addresses are most of what Settings is for, and an empty pane beside the
 * list is a wasted step. `replace`, so Back leaves Settings rather than bouncing here. An account
 * with no address is shown Add an address in the bare setup frame by the shell; this pane only
 * covers the moment before the shell knows.
 */
export const SettingsHome = () => {
  const { identities, areAddressesLoaded } = useMail();
  const isWide = useMediaQuery('(min-width: 64rem)');
  const first = [...identities].sort(byRole)[0];

  if (first === undefined) return areAddressesLoaded ? <AddAddress /> : null;
  if (!isWide) return null;
  return (
    <Navigate
      to="/settings/a/$address"
      params={{ address: first.address }}
      search={keepCompose}
      replace
    />
  );
};
