import type { AllSettings } from '@server/lib/settings';

/**
 * CSRF protection is on for new installs. A settings file from before, which
 * may lack the switch, keeps it off as it was.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const keepCsrfSetting = (settings: any): AllSettings => {
  if (
    settings.network &&
    typeof settings.network === 'object' &&
    typeof settings.network.csrfProtection !== 'boolean'
  ) {
    settings.network.csrfProtection = false;
  }
  return settings;
};

export default keepCsrfSetting;
