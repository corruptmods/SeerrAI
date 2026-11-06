import { MediaStatus } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  USER_ID,
} from '@server/constants/server';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import type { PlayLinkIds } from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import libraryAccess from '@server/lib/libraryAccess';
import type { QualitySlot, StoredQuality } from '@server/lib/mediaQuality';
import { availableQuality } from '@server/lib/mediaQuality';
import { connectedServers, serverName } from '@server/lib/mediaServers';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { In } from 'typeorm';

/*
 * "Show people only what their libraries hold" (main.limitToLibraries): for
 * people who don't manage requests or users, a title a media server has only
 * in libraries they can't open is left out of Recently Added and shown as
 * not available to them, with no play link for it.
 *
 * Which library holds a title comes from the scans (MediaLibraryItem); who
 * opens which library from the servers, cached per person. Whatever isn't
 * known (a title not scanned since, a server that can't be read) limits
 * nothing, as before.
 */

/** Libraries one person opens on a server: all, or these (scan ids). */
export type Reach = 'all' | Set<string>;

/** Per connected server. A server missing is unknown and limits nothing. */
export type ViewerReach = Partial<Record<MediaServerKind, Reach>>;

/** How long someone's libraries are remembered, in seconds. */
const REACH_TTL = 600;

/** How long a server that couldn't be read is left alone, in seconds. */
const UNREADABLE_TTL = 60;

type CachedReach = 'all' | 'unknown' | string[];

const reachCache = () => cacheManager.getCache('libraryaccess').data;

/** Reads in progress, so a page of titles reads each person once. */
const reading = new Map<string, Promise<Reach | undefined>>();

/** When each server's failure was last logged: once a minute at most. */
const warnedAt = new Map<MediaServerKind, number>();

const sameAccount = (kind: MediaServerKind, a: string, b: string): boolean =>
  kind === 'plex'
    ? a === b
    : (normalizeJellyfinGuid(a) ?? a) === (normalizeJellyfinGuid(b) ?? b);

/** Whether a Plex account is the server owner's, who sees every library. */
const isPlexOwner = async (accountId: string): Promise<boolean> => {
  const owner = await getRepository(User).findOne({
    where: { id: 1 },
    select: { id: true, plexId: true },
  });
  return owner?.plexId != null && String(owner.plexId) === accountId;
};

const readReach = async (
  kind: MediaServerKind,
  accountId: string
): Promise<Reach | undefined> => {
  const key = `${kind}:${accountId}`;
  try {
    const server = await libraryAccess.server(kind);
    const access = await server.read(accountId);
    const person = access.people.find((p) =>
      sameAccount(kind, p.id, accountId)
    );
    let reach: Reach;
    if (!person) {
      // Not shared with them, or the owner's own account.
      reach =
        kind === 'plex' && (await isPlexOwner(accountId)) ? 'all' : new Set();
    } else if (person.admin || person.all) {
      reach = 'all';
    } else {
      reach = new Set(
        person.libraries.map((id) =>
          MediaLibraryItem.key(kind, access.scanIds?.get(id) ?? id)
        )
      );
    }
    reachCache().set<CachedReach>(
      key,
      reach === 'all' ? 'all' : [...reach],
      REACH_TTL
    );
    return reach;
  } catch (e) {
    if (Date.now() - (warnedAt.get(kind) ?? 0) >= UNREADABLE_TTL * 1000) {
      warnedAt.set(kind, Date.now());
      logger.warn(
        `Could not read someone's ${serverName(kind)} libraries; showing them everything for now`,
        {
          label: 'Library Visibility',
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
    reachCache().set<CachedReach>(key, 'unknown', UNREADABLE_TTL);
    return undefined;
  }
};

/** The libraries one account opens on a server; undefined if unknown. */
export const accountReach = async (
  kind: MediaServerKind,
  accountId: string
): Promise<Reach | undefined> => {
  const key = `${kind}:${accountId}`;
  const cached = reachCache().get<CachedReach>(key);
  if (cached !== undefined) {
    return cached === 'unknown'
      ? undefined
      : cached === 'all'
        ? 'all'
        : new Set(cached);
  }
  let pending = reading.get(key);
  if (!pending) {
    pending = readReach(kind, accountId).finally(() => reading.delete(key));
    reading.set(key, pending);
  }
  return pending;
};

/** Whether someone sees every title whatever their libraries. */
const seesEverything = (user: User): boolean =>
  user.hasPermission([Permission.MANAGE_REQUESTS, Permission.MANAGE_USERS], {
    type: 'or',
  });

/**
 * What a viewer's libraries hold on each connected server; undefined when
 * nothing is limited for them: the setting off, or someone who sees
 * everything. An account not linked to a server opens none of its libraries,
 * so unlinking one, or never linking, shows no more.
 */
export const viewerReach = async (
  user: User | undefined
): Promise<ViewerReach | undefined> => {
  if (!getSettings().main.limitToLibraries || !user || seesEverything(user)) {
    return undefined;
  }
  const servers = connectedServers();
  const reach: ViewerReach = {};
  await Promise.all(
    servers.map(async (kind) => {
      const accountId = user[USER_ID[kind]];
      // Not linked to this server: none of its libraries.
      const found = accountId
        ? await accountReach(kind, String(accountId))
        : new Set<string>();
      if (found) reach[kind] = found;
    })
  );
  return Object.values(reach).some((r) => r !== 'all') ? reach : undefined;
};

type Item = Pick<MediaLibraryItem, 'server' | 'libraryId' | 'is4k' | 'itemId'>;

/**
 * Whether the viewer opens a title's standard or 4K copy, and the item to
 * link on each server: a string links that item, null nothing, undefined
 * keeps the title's own. Unknown (no server item, no library recorded, a
 * server not read) counts as open.
 */
export const openingOf = (
  media: Pick<Media, (typeof MEDIA_ID)[MediaServerKind][number]>,
  items: Item[],
  reach: ViewerReach,
  is4k: boolean,
  servers: MediaServerKind[] = connectedServers()
): {
  open: boolean;
  links: Partial<Record<MediaServerKind, string | null>>;
  /** The servers holding it that the viewer opens it on. */
  openOn: MediaServerKind[];
} => {
  const links: Partial<Record<MediaServerKind, string | null>> = {};
  const openOn: MediaServerKind[] = [];
  let held = false;
  let open = false;
  for (const kind of servers) {
    const own = media[MEDIA_ID[kind][is4k ? 1 : 0]];
    if (!own) continue;
    held = true;
    const opens = reach[kind];
    const listed = items.filter(
      (item) => item.server === kind && item.is4k === is4k
    );
    if (!opens || opens === 'all' || !listed.length) {
      open = true;
      openOn.push(kind);
      continue;
    }
    const reachable = listed.filter((item) => opens.has(item.libraryId));
    if (!reachable.length) {
      links[kind] = null;
      continue;
    }
    open = true;
    openOn.push(kind);
    if (!reachable.some((item) => item.itemId === own)) {
      links[kind] = reachable[0].itemId;
    }
  }
  return { open: open || !held, links, openOn };
};

/** A side's quality badges from the servers the viewer opens it on. */
const qualityOn = (
  media: Media,
  slot: QualitySlot,
  openOn: MediaServerKind[]
) => {
  const kept: StoredQuality = { ...media.quality };
  for (const kind of MEDIA_SERVER_KINDS) {
    if (!openOn.includes(kind)) delete kept[kind];
  }
  return availableQuality({ ...media, quality: kept }, slot);
};

const AVAILABLE = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];

/** Shows a title as a viewer with these libraries may see it. */
export const applyReach = (
  media: Media,
  items: Item[],
  reach: ViewerReach,
  servers: MediaServerKind[] = connectedServers()
): void => {
  const standard = openingOf(media, items, reach, false, servers);
  const fourK = openingOf(media, items, reach, true, servers);
  const hide = (key: 'status' | 'status4k') => {
    if (AVAILABLE.includes(media[key])) media[key] = MediaStatus.UNKNOWN;
    for (const season of media.seasons ?? []) {
      if (AVAILABLE.includes(season[key])) season[key] = MediaStatus.UNKNOWN;
    }
  };
  if (!standard.open) {
    hide('status');
    media.outsideLibraries = true;
    media.availableQuality = undefined;
  } else if (media.availableQuality) {
    media.availableQuality = qualityOn(media, 'standard', standard.openOn);
  }
  if (!fourK.open) {
    hide('status4k');
    media.outsideLibraries4k = true;
    media.availableQuality4k = undefined;
  } else if (media.availableQuality4k) {
    media.availableQuality4k = qualityOn(media, '4k', fourK.openOn);
  }
  const ids: PlayLinkIds = {};
  for (const kind of servers) {
    const id = standard.links[kind];
    const id4k = fourK.links[kind];
    if (id !== undefined || id4k !== undefined) ids[kind] = { id, id4k };
  }
  if (Object.keys(ids).length) media.setPlayLinks(ids);
};

/**
 * Shows these titles as the viewer may see them (see applyReach), with one
 * read of where they are. Nothing changes for those not limited.
 */
export const limitToLibraries = async (
  media: (Media | undefined | null)[],
  user: User | undefined
): Promise<void> => {
  const titles = media.filter((m): m is Media => !!m?.id);
  if (!titles.length) return;
  const reach = await viewerReach(user);
  if (!reach) return;
  let rows: (Item & { mediaId: number })[];
  try {
    rows = await getRepository(MediaLibraryItem).find({
      select: {
        mediaId: true,
        server: true,
        libraryId: true,
        is4k: true,
        itemId: true,
      },
      where: { mediaId: In(titles.map((m) => m.id)) },
    });
  } catch (e) {
    logger.warn(
      'Could not read which libraries hold titles; showing them all',
      {
        label: 'Library Visibility',
        errorMessage: e instanceof Error ? e.message : String(e),
      }
    );
    return;
  }
  const byMedia = new Map<number, Item[]>();
  for (const row of rows) {
    byMedia.set(row.mediaId, [...(byMedia.get(row.mediaId) ?? []), row]);
  }
  const servers = connectedServers();
  for (const title of titles) {
    applyReach(title, byMedia.get(title.id) ?? [], reach, servers);
  }
};

/**
 * Leaves out of a query of titles those whose standard copy the viewer
 * can't open (openingOf, in SQL), so pages stay full.
 */
export const leaveOutUnreachable = <T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  reach: ViewerReach,
  alias = 'media'
): SelectQueryBuilder<T> => {
  const servers = connectedServers();
  if (!servers.some((kind) => reach[kind] instanceof Set)) return query;
  const q = (name: string) => query.connection.driver.escape(name);
  const table = q(query.connection.getMetadata(MediaLibraryItem).tableName);
  const parentId = `${q(alias)}.${q('id')}`;
  const params: Record<string, unknown> = { lvStandard: false };
  const itemsOn = (kind: MediaServerKind, alias: string, libraries?: string) =>
    `EXISTS (SELECT 1 FROM ${table} ${q(alias)} WHERE ${q(alias)}.${q('mediaId')} = ${parentId} AND ${q(alias)}.${q('server')} = :lvServer_${kind} AND ${q(alias)}.${q('is4k')} = :lvStandard${libraries ? ` AND ${q(alias)}.${q('libraryId')} IN (:...${libraries})` : ''})`;
  const held: string[] = [];
  const shut: string[] = [];
  for (const kind of servers) {
    const column = `${q(alias)}.${q(MEDIA_ID[kind][0])}`;
    held.push(`${column} IS NOT NULL`);
    const opens = reach[kind];
    if (!(opens instanceof Set)) {
      shut.push(`${column} IS NULL`);
      continue;
    }
    params[`lvServer_${kind}`] = kind;
    const listed = itemsOn(kind, `lv_${kind}`);
    if (!opens.size) {
      shut.push(`(${column} IS NULL OR ${listed})`);
      continue;
    }
    params[`lvLibraries_${kind}`] = [...opens];
    const reachable = itemsOn(kind, `lvo_${kind}`, `lvLibraries_${kind}`);
    shut.push(`(${column} IS NULL OR (${listed} AND NOT ${reachable}))`);
  }
  return query.andWhere(
    `NOT ((${held.join(' OR ')}) AND ${shut.join(' AND ')})`,
    params
  );
};
