import type { ArrCustomFormat, ArrExtras } from '@server/lib/autofix/arr';
import { FixRadarr, FixSonarr } from '@server/lib/autofix/arr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Release groups an admin has blocked. Seerr AI's own searches (Backfill and
 * the admin agent) pass over their releases, and Radarr and Sonarr are
 * given a custom format that matches them, scored in every quality profile
 * low enough that nothing carrying it is ever acceptable, so they never
 * grab one either. A file already on disk from a blocked group scores as
 * low too, so Radarr and Sonarr take the next acceptable release as an
 * upgrade, and replace the file only once that one has imported.
 *
 * Only the one custom format below is ever touched; formats an admin made
 * in Radarr or Sonarr themselves are left alone.
 */

export const BLOCK_FORMAT_NAME = 'Seerr AI: blocked release groups';
const LABEL = 'Blocked groups';

/** What a group's name may be: what release names carry after the dash. */
export const GROUP_NAME = /^[\w][\w.\- ]{0,59}$/;

export const blockedGroups = (): string[] =>
  getSettings().backfill.blockedGroups ?? [];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A group named as its own word, however the release spells the rest. */
const wordOf = (group: string) =>
  new RegExp(`(?:^|[^a-z0-9])${escape(group)}(?:$|[^a-z0-9])`, 'i');

/**
 * The blocked group a release belongs to, by the group its indexer or
 * Radarr/Sonarr read, or by the group's name as a word of the title (a
 * torrent can name it with spaces, "x264 quillowsap mp4", and no group is
 * read at all). Undefined when it is not blocked.
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
 * A score low enough that nothing with it is acceptable in this profile,
 * whatever else it scores: below the minimum even with every other format
 * the profile rewards.
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

/** Brings one Radarr or Sonarr in line with the list. */
const syncOne = async (api: ArrExtras, groups: string[]): Promise<void> => {
  const formats = await api.customFormats();
  const existing = formats.find((f) => f.name === BLOCK_FORMAT_NAME);
  if (!groups.length) {
    // Nothing blocked: the format goes, and with it its scores.
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
 * Brings every Radarr and Sonarr in line with the blocked groups. Returns
 * what could not be done, server by server, in words; empty when all went.
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
