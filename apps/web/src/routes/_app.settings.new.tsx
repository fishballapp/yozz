import { createFileRoute } from '@tanstack/react-router';
import { AddAddress } from '../app/settings/AddAddress';

export const Route = createFileRoute('/_app/settings/new')({
  staticData: { title: 'Add an address' },
  component: AddAddress,
});
