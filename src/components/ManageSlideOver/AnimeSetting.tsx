import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type {
  AnimePlacement,
  AnimePlacementResult,
  AnimePlacementServer,
} from '@server/lib/animePlacement';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.ManageSlideOver.AnimeSetting', {
  anime: 'Anime',
  treatedAsAnime: 'Treated as anime',
  treatedAsNotAnime: 'Treated as not anime',
  byTitle: 'set here',
  byRule: 'chosen on its request',
  byDetection: 'detected automatically',
  setting: 'Setting',
  automaticAnime: 'Automatic (anime)',
  automaticNotAnime: 'Automatic (not anime)',
  detectedAnime: 'Detection says anime.',
  detectedNotAnime: 'Detection says not anime.',
  setAnime: 'Anime',
  setNotAnime: 'Not anime',
  inPlace: 'Where it belongs.',
  willMove: 'To match the setting:',
  belongsIn: 'Moves to {folder}',
  belongsOn: 'Goes on {profile}',
  belongsTyped: 'Typed {seriesType}',
  notInArr:
    'Not in {arr} yet. The Anime tick in its request dialog starts from what is set here.',
  serverError: '{server} could not be read: {error}',
  saveHint:
    'Saving puts it where the setting says in {arr}: the anime or regular root folder (files are moved, which takes a while for a big title), quality profile and, for a series, series type. Anime or not chosen on its requests that says otherwise is replaced.',
  save: 'Save',
  saveAndMove: 'Save and Move',
  saving: 'Saving…',
  saved: 'Saved.',
  moved: 'Saved. {servers} {count, plural, one {is} other {are}} moving it.',
  moveFailed: 'Saved, but {server} could not be changed: {error}',
  loadError: 'Could not check where this sits: {error}',
  saveError: 'Could not save: {error}',
});

type Choice = 'auto' | 'anime' | 'standard';

const choiceOf = (setting: boolean | null): Choice =>
  setting === null ? 'auto' : setting ? 'anime' : 'standard';

const settingOf = (choice: Choice): boolean | null =>
  choice === 'auto' ? null : choice === 'anime';

const errorOf = (e: unknown) =>
  axios.isAxiosError(e)
    ? (e.response?.data?.message ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

/**
 * Whether a title is anime, set by hand when detection gets it wrong, and
 * where it sits in Sonarr or Radarr against that (lib/animePlacement).
 * Admins only; read only while the manage panel is open.
 */
const AnimeSetting = ({
  mediaId,
  mediaType,
  show,
  onSaved,
}: {
  mediaId: number;
  mediaType: 'movie' | 'tv';
  show: boolean;
  onSaved: () => void;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<AnimePlacement>(
    show ? `/api/v1/media/${mediaId}/anime` : null,
    { revalidateOnFocus: false }
  );
  const [choice, setChoice] = useState<Choice>('auto');
  const [saving, setSaving] = useState(false);
  const arr = mediaType === 'movie' ? 'Radarr' : 'Sonarr';

  useEffect(() => {
    if (data) {
      setChoice(choiceOf(data.animeSetting));
    }
  }, [data]);

  const changed = !!data && choice !== choiceOf(data.animeSetting);
  // What saving the chosen setting would change on a server.
  const changesFor = (server: AnimePlacementServer) => {
    const anime = choice === 'auto' ? server.automatic : choice === 'anime';
    return anime ? server.ifAnime : server.ifNotAnime;
  };
  const pending = (data?.servers ?? []).some(
    (server) => !server.error && Object.keys(changesFor(server)).length > 0
  );

  const save = async () => {
    setSaving(true);
    try {
      const response = await axios.put<AnimePlacementResult>(
        `/api/v1/media/${mediaId}/anime`,
        { animeSetting: settingOf(choice) }
      );
      const { applied, ...placement } = response.data;
      await mutate(placement, { revalidate: false });
      const failed = applied.filter((item) => item.error);
      const moved = applied.filter((item) => !item.error);
      failed.forEach((item) =>
        addToast(
          intl.formatMessage(messages.moveFailed, {
            server: item.serverName,
            error: item.error,
          }),
          { appearance: 'error', autoDismiss: false }
        )
      );
      if (!failed.length) {
        addToast(
          moved.length
            ? intl.formatMessage(messages.moved, {
                servers: moved.map((item) => item.serverName).join(', '),
                count: moved.length,
              })
            : intl.formatMessage(messages.saved),
          { appearance: 'success', autoDismiss: true }
        );
      }
      onSaved();
    } catch (e) {
      addToast(intl.formatMessage(messages.saveError, { error: errorOf(e) }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  const serverBadges = (server: AnimePlacementServer) => {
    const changes = changesFor(server);
    return [
      ...(changes.rootFolderPath
        ? [
            intl.formatMessage(messages.belongsIn, {
              folder: changes.rootFolderPath,
            }),
          ]
        : []),
      ...(changes.qualityProfileId
        ? [
            intl.formatMessage(messages.belongsOn, {
              profile:
                changes.qualityProfileName ?? String(changes.qualityProfileId),
            }),
          ]
        : []),
      ...(changes.seriesType
        ? [
            intl.formatMessage(messages.belongsTyped, {
              seriesType: changes.seriesType,
            }),
          ]
        : []),
    ];
  };

  return (
    <div>
      <h3 className="mb-2 text-xl font-bold">
        {intl.formatMessage(messages.anime)}
      </h3>
      {error ? (
        <p className="text-sm text-red-400">
          {intl.formatMessage(messages.loadError, { error: errorOf(error) })}
        </p>
      ) : !data ? (
        <div className="h-24 animate-pulse rounded-md bg-gray-800" />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-300">
            {intl.formatMessage(
              data.anime ? messages.treatedAsAnime : messages.treatedAsNotAnime
            )}{' '}
            <span className="text-gray-400">
              (
              {intl.formatMessage(
                data.decidedBy === 'title'
                  ? messages.byTitle
                  : data.decidedBy === 'request'
                    ? messages.byRule
                    : messages.byDetection
              )}
              ).{' '}
              {data.decidedBy !== 'detection' &&
                intl.formatMessage(
                  data.detected
                    ? messages.detectedAnime
                    : messages.detectedNotAnime
                )}
            </span>
          </p>

          <div className="overflow-hidden rounded-md border border-gray-700 shadow">
            {data.servers.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-400">
                {intl.formatMessage(messages.notInArr, { arr })}
              </p>
            ) : (
              <ul>
                {data.servers.map((server) => {
                  const badges = serverBadges(server);
                  return (
                    <li
                      key={`anime-${server.service}-${server.serverId}`}
                      className="space-y-1 border-b border-gray-700 px-4 py-3 text-sm last:border-b-0"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-gray-100">
                        <span className="font-semibold">
                          {server.serverName}
                        </span>
                        {server.is4k && <Badge badgeType="warning">4K</Badge>}
                      </div>
                      {server.error ? (
                        <p className="text-red-400">
                          {intl.formatMessage(messages.serverError, {
                            server: server.serverName,
                            error: server.error,
                          })}
                        </p>
                      ) : (
                        <>
                          <p className="break-all text-xs text-gray-400">
                            {[
                              server.path,
                              server.qualityProfile,
                              server.seriesType,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          {badges.length ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="text-gray-400">
                                {intl.formatMessage(messages.willMove)}
                              </span>
                              {badges.map((badge) => (
                                <span
                                  key={badge}
                                  className="rounded bg-yellow-500/20 px-2 py-0.5 text-yellow-200"
                                >
                                  {badge}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-green-400">
                              {intl.formatMessage(messages.inPlace)}
                            </p>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <label
              htmlFor={`anime-setting-${mediaId}`}
              className="mb-1 block text-sm font-medium text-gray-300"
            >
              {intl.formatMessage(messages.setting)}
            </label>
            <select
              id={`anime-setting-${mediaId}`}
              value={choice}
              disabled={saving}
              onChange={(e) => setChoice(e.target.value as Choice)}
            >
              <option value="auto">
                {intl.formatMessage(
                  data.automatic
                    ? messages.automaticAnime
                    : messages.automaticNotAnime
                )}
              </option>
              <option value="anime">
                {intl.formatMessage(messages.setAnime)}
              </option>
              <option value="standard">
                {intl.formatMessage(messages.setNotAnime)}
              </option>
            </select>
          </div>
          {data.servers.length > 0 && (
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.saveHint, { arr })}
            </p>
          )}
          <Button
            buttonType="primary"
            className="w-full"
            disabled={saving || (!changed && !pending)}
            onClick={save}
          >
            <ArrowDownOnSquareIcon />
            <span>
              {intl.formatMessage(
                saving
                  ? messages.saving
                  : data.servers.length > 0
                    ? messages.saveAndMove
                    : messages.save
              )}
            </span>
          </Button>
        </div>
      )}
    </div>
  );
};

export default AnimeSetting;
