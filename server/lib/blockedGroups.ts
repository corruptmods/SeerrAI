import type { ArrCustomFormat, ArrExtras } from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Release groups an admin has blocked. Seerr AI's own searches (Backfill and
 * the admin agent) skip their releases. Radarr and Sonarr get a custom format
 * matching them, scored in every quality profile so low that no release with
 * it is acceptable. A blocked group's file already on disk scores as low, so
 * it is replaced once an acceptable upgrade imports.
 *
 * Only the format named below is touched; admin-made formats are left alone.
 */

export const BLOCK_FORMAT_NAME = 'Seerr AI: blocked release groups';
const LABEL = 'Blocked groups';

/** A valid group name: what release names carry after the dash. */
export const GROUP_NAME = /^[\w][\w.\- ]{0,59}$/;

export const blockedGroups = (): string[] =>
  getSettings().backfill.blockedGroups ?? [];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches the group as a whole word, case-insensitive. */
const wordOf = (group: string) =>
  new RegExp(`(?:^|[^a-z0-9])${escape(group)}(?:$|[^a-z0-9])`, 'i');

/**
 * The blocked group a release belongs to, by its parsed group or by the
 * group's name as a word of the title (torrents can name it with spaces,
 * "x264 quillowsap mp4", with no group parsed). Undefined when not blocked.
 */
export const blockedGroupOf = (
  title: string,
  group?: string | null,
  blocked: string[] = blockedGroups()
): string | undefined =>
  blocked.find(
    (b) =>
      (group && group.toLowerCase() === b.toLowerCase()) ||
      wordOf(b).test(title)
  );

/** The custom format matching these groups, by group and by title. */
export const blockFormat = (groups: string[]): ArrCustomFormat => {
  const any = groups.map(escape).join('|');
  return {
    name: BLOCK_FORMAT_NAME,
    includeCustomFormatWhenRenaming: false,
    specifications: [
      {
        name: 'Release group',
        implementation: 'ReleaseGroupSpecification',
        negate: false,
        required: false,
        fields: [{ name: 'value', value: `^(?:${any})$` }],
      },
      {
        name: 'Release title',
        implementation: 'ReleaseTitleSpecification',
        negate: false,
        required: false,
        fields: [
          { name: 'value', value: `(?:^|[^a-z0-9])(?:${any})(?:$|[^a-z0-9])` },
        ],
      },
    ],
  };
};

/**
 * A score that keeps a release below the profile's minimum even with every
 * other rewarded format.
 */
export const blockScore = (
  profile: {
    minFormatScore?: number;
    formatItems?: { format: number; score: number }[];
  },
  formatId?: number
): number => {
  const rewards = (profile.formatItems ?? [])
    .filter((item) => item.format !== formatId && item.score > 0)
    .reduce((n, item) => n + item.score, 0);
  return -(1 + rewards + Math.abs(profile.minFormatScore ?? 0));
};

/** Syncs one Radarr or Sonarr with the list. */
const syncOne = async (api: ArrExtras, groups: string[]): Promise<void> => {
  const formats = await api.customFormats();
  const existing = formats.find((f) => f.name === BLOCK_FORMAT_NAME);
  if (!groups.length) {
    // Nothing blocked: delete the format, and its scores with it.
    if (existing?.id) await api.deleteCustomFormat(existing.id);
    return;
  }
  const saved = await api.saveCustomFormat({
    ...blockFormat(groups),
    ...(existing?.id ? { id: existing.id } : {}),
  });
  const id = saved.id ?? existing?.id;
  if (!id) throw new Error('The custom format was not saved.');
  for (const profile of await api.qualityProfiles()) {
    const score = blockScore(profile, id);
    const items = profile.formatItems ?? [];
    const item = items.find((i) => i.format === id);
    if (item?.score === score) continue;
    await api.saveQualityProfile({
      ...profile,
      formatItems: item
        ? items.map((i) => (i.format === id ? { ...i, score } : i))
        : [...items, { format: id, name: BLOCK_FORMAT_NAME, score }],
    });
  }
};

/**
 * Syncs every Radarr and Sonarr with the blocked groups. Returns one message
 * per failed server.
 */
export const syncBlockedGroups = async (): Promise<string[]> => {
  const settings = getSettings();
  const groups = blockedGroups();
  const servers = [
    ...settings.radarr.map((s) => ({
      name: s.name,
      api: FixRadarr.forServer(s).extras,
    })),
    ...settings.sonarr.map((s) => ({
      name: s.name,
      api: FixSonarr.forServer(s).extras,
    })),
  ];
  const problems: string[] = [];
  for (const server of servers) {
    try {
      await syncOne(server.api, groups);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      logger.warn('Could not update the blocked release groups', {
        label: LABEL,
        server: server.name,
        errorMessage: why,
      });
      problems.push(`${server.name} could not be updated (${why}).`);
    }
  }
  return problems;
};

/** Adds or removes a group, saves, and updates Radarr and Sonarr. */
export const setGroupBlocked = async (
  group: string,
  blocked: boolean
): Promise<{ groups: string[]; problems: string[] }> => {
  const name = group.trim();
  if (!GROUP_NAME.test(name)) {
    throw new Error(`"${group}" is not a release group's name.`);
  }
  const settings = getSettings();
  const current = settings.backfill.blockedGroups ?? [];
  const without = current.filter((g) => g.toLowerCase() !== name.toLowerCase());
  const groups = blocked ? [...without, name] : without;
  settings.backfill = { ...settings.backfill, blockedGroups: groups };
  await settings.save();
  return { groups, problems: await syncBlockedGroups() };
};
