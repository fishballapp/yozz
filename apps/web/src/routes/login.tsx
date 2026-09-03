import { createFileRoute } from '@tanstack/react-router';
import { Login } from '../vault/Login';

export const Route = createFileRoute('/login')({
  component: Login,
});
