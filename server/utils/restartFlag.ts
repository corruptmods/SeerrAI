import type { AllSettings, NetworkSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

class RestartFlag {
  private networkSettings: NetworkSettings;

  public initializeSettings(settings: AllSettings): void {
    this.networkSettings = {
      ...settings.network,
      proxy: { ...settings.network.proxy },
      trustedProxies: [...settings.network.trustedProxies],
    };
  }

  public isSet(): boolean {
    const networkSettings = getSettings().network;

    return (
      this.networkSettings.csrfProtection !== networkSettings.csrfProtection ||
      this.networkSettings.trustProxy !== networkSettings.trustProxy ||
      // Which proxies are trusted is also set once, at start.
      this.networkSettings.trustCloudflare !==
        networkSettings.trustCloudflare ||
      this.networkSettings.trustedProxies.join() !==
        networkSettings.trustedProxies.join() ||
      this.networkSettings.proxy.enabled !== networkSettings.proxy.enabled
    );
  }
}

const restartFlag = new RestartFlag();

export default restartFlag;
