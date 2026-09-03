import { createFileRoute } from '@tanstack/react-router';
import { Addresses } from '../app/settings/Addresses';

export const Route = createFileRoute('/_app/settings/')({ component: Addresses });
