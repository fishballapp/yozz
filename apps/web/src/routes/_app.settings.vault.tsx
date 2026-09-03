import { createFileRoute } from '@tanstack/react-router';
import { Vault } from '../app/settings/Vault';

export const Route = createFileRoute('/_app/settings/vault')({ component: Vault });
