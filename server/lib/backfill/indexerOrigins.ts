import { originKey } from '@server/api/prowlarr';
import type ServarrBase from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { lidarrApi } from '@server/lib/music/access';
import { getSettings } from '@server/lib/settings';

/** Every Sonarr, Radarr and Lidarr set up here, by name. */
export const arrApps = (): {
  name: string;
  api: ServarrBase<unknown>;
}[] => {
  const settings = getSettings();
  return [
    ...settings.sonarr.map((s) => ({
      name: s.name,
      api: new SonarrAPI({
        apiKey: s.apiKey,
        url: SonarrAPI.buildUrl(s, '/api/v3'),
      }) as ServarrBase<unknown>,
    })),
    ...settings.radarr.map((s) => ({
      name: s.name,
      api: new RadarrAPI({
        apiKey: s.apiKey,
        url: RadarrAPI.buildUrl(s, '/api/v3'),
      }) as ServarrBase<unknown>,
    })),
    ...settings.lidarr.map((s) => ({
      name: s.name,
      api: lidarrApi(s) as ServarrBase<unknown>,
    })),
  ];
};

const KEEP_MS = 10 * 60 * 1000;
let kept: { at: number; origins: Promise<ReadonlySet<string>> } | undefined;

/**
 * The hosts and ports of the indexers the *arr apps have set up (a Jackett on
 * this network, say), whose links Backfill may follow. Read again every ten
 * minutes; an app that doesn't answer adds none.
 */
export const arrIndexerOrigins = (): Promise<ReadonlySet<string>> => {
  if (!kept || Date.now() - kept.at > KEEP_MS) {
    kept = {
      at: Date.now(),
      origins: Promise.all(
        arrApps().map(({ api }) => api.getIndexerUrls().catch(() => []))
      ).then(
        (lists) =>
          new Set(
            lists.flat().flatMap((url) => {
              try {
                return [originKey(new URL(url))];
              } catch {
                return [];
              }
            })
          )
      ),
    };
  }
  return kept.origins;
};

/** Forgets the indexers read, so the next fetch reads them again. */
export const forgetArrIndexerOrigins = (): void => {
  kept = undefined;
};
