import { createFileRoute } from '@tanstack/react-router';
import { Advanced } from '../app/settings/Advanced';

export const Route = createFileRoute('/_app/settings/advanced')({
  staticData: { title: 'Advanced' },
  component: Advanced,
});
