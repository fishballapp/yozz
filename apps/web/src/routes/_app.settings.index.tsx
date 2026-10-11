import { createFileRoute } from '@tanstack/react-router';
import { SettingsHome } from '../app/settings/SettingsHome';

export const Route = createFileRoute('/_app/settings/')({ component: SettingsHome });
