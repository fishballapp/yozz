import { ServerKeysSection } from '../../relay/ServerKeysSection';
import { SettingsPane } from './SettingsPane';

/** Things most people never need to look at, kept off the Account pane. */
export const Advanced = () => (
  <SettingsPane title="Advanced">
    <ServerKeysSection empty="No server keys yet. One appears here the first time this device connects to a server that no address of yours uses." />
  </SettingsPane>
);
