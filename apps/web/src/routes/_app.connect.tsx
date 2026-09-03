import { createFileRoute } from '@tanstack/react-router';
import { Connect } from '../app/Connect';

export const Route = createFileRoute('/_app/connect')({
  staticData: { title: 'Add an address' },
  component: Connect,
});
