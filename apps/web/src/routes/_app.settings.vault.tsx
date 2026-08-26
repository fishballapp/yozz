import { createFileRoute } from '@tanstack/react-router';
import { Vault } from '../pages/settings/Vault';

export const Route = createFileRoute('/_app/settings/vault')({ component: Vault });
