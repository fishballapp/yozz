import { createFileRoute } from '@tanstack/react-router';
import { Addresses } from '../pages/settings/Addresses';

export const Route = createFileRoute('/_app/settings/')({ component: Addresses });
