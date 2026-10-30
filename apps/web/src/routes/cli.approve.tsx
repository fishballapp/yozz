import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CliApprove } from '../app/CliApprove';

/** Bare, like Log in: the approval is the whole page. The query is parsed by the page, from the raw string. */
export const Route = createFileRoute('/cli/approve')({
  component: CliApproveRoute,
});

function CliApproveRoute() {
  const search = useLocation({ select: location => location.searchStr });
  return <CliApprove search={search} />;
}
