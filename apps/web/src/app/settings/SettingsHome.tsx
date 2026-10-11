import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { keepCompose } from '../../compose/intent';
import { useMail } from '../../store/MailProvider';
import { byRole } from '../Settings';
import { AddAddress } from './AddAddress';

/**
 * `/settings` is the list on a phone, and the pane beside it shows nothing worth a screen of its
 * own, so on a wide screen it opens the first address. With none stored, adding one is the only
 * thing Settings has to offer.
 */
export const SettingsHome = () => {
  const { identities } = useMail();
  const navigate = useNavigate();
  const first = [...identities].sort(byRole)[0]?.address;

  useEffect(() => {
    if (first === undefined) return;
    const wide = matchMedia('(min-width: 64rem)');
    const open = () => {
      if (!wide.matches) return;
      void navigate({
        to: '/settings/a/$address',
        params: { address: first },
        search: keepCompose,
        replace: true,
      });
    };
    open();
    wide.addEventListener('change', open);
    return () => wide.removeEventListener('change', open);
  }, [first, navigate]);

  return first === undefined ? <AddAddress /> : null;
};
