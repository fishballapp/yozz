import { createFileRoute } from '@tanstack/react-router';
import { Account } from '../app/settings/Account';

export const Route = createFileRoute('/_app/settings/account')({
  staticData: { title: 'Account' },
  component: Account,
});
