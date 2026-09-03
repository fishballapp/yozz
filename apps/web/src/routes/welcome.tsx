import { createFileRoute } from '@tanstack/react-router';
import { Welcome } from '../vault/Welcome';

export const Route = createFileRoute('/welcome')({
  component: Welcome,
});
