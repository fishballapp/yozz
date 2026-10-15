import { createFileRoute } from '@tanstack/react-router';
import { RemoteImages } from '../app/settings/RemoteImages';

export const Route = createFileRoute('/_app/settings/images')({
  staticData: { title: 'Remote images' },
  component: RemoteImages,
});
