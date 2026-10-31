import type { TorrentClient } from '@server/api/downloadclients';
import { isTorrentClient, torrentClientFor } from '@server/api/downloadclients';
import { getRepository } from '@server/datasource';
import BackfillSeries from '@server/entity/BackfillSeries';
import type {
  CheckAction,
  CheckFinding,
  CheckStage,
  CheckStatus,
  RejectAfter,
} from '@server/entity/DownloadCheck';
import DownloadCheck from '@server/entity/DownloadCheck';
import { episodeTitled, titleFits } from '@server/lib/agent/numbering';
import backfill from '@server/lib/backfill/engine';
import type {
  CheckServer,
  Grab,
  HeldFile,
  ImportCandidate,
  ImportFile,
  ItemFacts,
  QueueEpisode,
} from '@server/lib/downloadCheck/arr';
import { CheckRadarr, CheckSonarr } from '@server/lib/downloadCheck/arr';
import type { Evidence } from '@server/lib/downloadCheck/names';
import {
  GENERIC_EPISODE,
  judgeName,
  normalize,
  readEpisodeRelease,
  readMovieRelease,
} from '@server/lib/downloadCheck/names';
import type {
  ImportProblem,
  ProfileRanks,
} from '@server/lib/downloadCheck/rules';
import {
  SAMPLE_BYTES,
  checkFiles,
  compareGrabs,
  hoursBeforeAir,
  importProblemOf,
  isUpgrade,
  planImport,
  ranksOf,
} from '@server/lib/downloadCheck/rules';
import type {
  DVRSettings,
  DownloadCheckMode,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Download Check: looks at every download Sonarr and Radarr have in their
 * queues, twice a minute, for what would keep it from being imported or
 * shows it isn't what it says.
 *
 * Before it comes down (or while a delay profile still holds it): a program
 * among its files, nothing but archives or samples, an episode that hadn't
 * aired, another show or version under this one's name, no better than the
 * file there, or a better copy already in the queue. Once it's down and the
 * import is stuck, the server's own reason: imported, with the episodes it
 * really is, when the name shows it's the right title; thrown away and
 * searched again when nothing in it will do; left for an admin when it
 * can't be told.
 *
 * With Report only, it says what it would do and does nothing. Nothing here
 * uses AI: every decision is a rule over what the servers say.
 */

const LABEL = 'Download Check';

/** A stuck import gets this long to clear by itself before anything's done. */
export const BLOCKED_FOR_MS = 2 * 60_000;

/** How long an import is followed before it's taken as started, not done. */
const IMPORT_WAIT_MS = 90_000;
const IMPORT_POLL_MS = 3_000;
/**
 * How long after a Backfill search of a title a grab numbered another way
 * doesn't start another: one that recent has looked already.
 */
const LOOK_AGAIN_MS = 6 * 60 * 60 * 1000;

/** States a download is in before it's down. */
const DOWNLOADING = [
  'delay',
  'queued',
  'downloading',
  'paused',
  'downloadclientunavailable',
  'warning',
];

export interface Decision {
  finding: CheckFinding;
  action: CheckAction;
  params?: Record<string, unknown>;
  /** The server's words, for a stuck import. */
  detail?: string;
}

export interface ServerRef {
  app: 'sonarr' | 'radarr';
  settings: SonarrSettings | RadarrSettings;
}

/** Whether a download is still coming down, or done and stuck. */
export const stageOf = (grab: Grab): CheckStage | undefined => {
  if (
    grab.state === 'importblocked' ||
    ((grab.state === 'importpending' || grab.status === 'completed') &&
      grab.trackedStatus === 'warning' &&
      grab.messages.length > 0)
  ) {
    return 'import';
  }
  if (
    DOWNLOADING.includes(grab.status) &&
    (!grab.state || grab.state === 'downloading')
  ) {
    return 'grab';
  }
  return undefined;
};

/** "S01E03", "S01E03-E04", "S02 (10 episodes)". */
export const episodesLabel = (episodes: QueueEpisode[]): string => {
  if (!episodes.length) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const sorted = [...episodes].sort(
    (a, b) =>
      a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
  );
  const seasons = [...new Set(sorted.map((e) => e.seasonNumber))];
  if (sorted.length === 1) {
    return `S${pad(sorted[0].seasonNumber)}E${pad(sorted[0].episodeNumber)}`;
  }
  if (seasons.length === 1 && sorted.length <= 3) {
    return `S${pad(seasons[0])}${sorted
      .map((e) => `E${pad(e.episodeNumber)}`)
      .join('-')}`;
  }
  return seasons.length === 1
    ? `S${pad(seasons[0])} (${sorted.length})`
    : `S${pad(seasons[0])}–S${pad(seasons[seasons.length - 1])} (${sorted.length})`;
};

/** What's asked of each server in one pass, asked once. */
export class Pass {
  private factsOf = new Map<number, Promise<ItemFacts>>();
  private episodesOf = new Map<number, Promise<QueueEpisode[]>>();
  private filesOf = new Map<number, Promise<Map<number, HeldFile>>>();
  private ranksOf = new Map<number, Promise<ProfileRanks>>();

  constructor(public readonly server: CheckServer) {}

  private once<K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>) {
    let value = map.get(key);
    if (!value) {
      value = load();
      map.set(key, value);
      // A failure isn't kept: the next look asks again.
      value.catch(() => map.delete(key));
    }
    return value;
  }

  facts(itemId: number) {
    return this.once(this.factsOf, itemId, () => this.server.facts(itemId));
  }

  episodes(itemId: number) {
    return this.once(this.episodesOf, itemId, () =>
      this.server.episodes(itemId)
    );
  }

  files(itemId: number) {
    return this.once(this.filesOf, itemId, () => this.server.files(itemId));
  }

  ranks(profileId: number) {
    return this.once(this.ranksOf, profileId, async () =>
      ranksOf(
        (await this.server.profile(profileId)) as Parameters<typeof ranksOf>[0]
      )
    );
  }
}

/** What's known of a download between passes, kept in memory. */
interface Seen {
  /** Its name, timing and quality have been looked at. */
  named?: boolean;
  /** Its files have been looked at (torrents, once the client lists them). */
  filesLooked?: boolean;
  /** When its import was first seen stuck. */
  blockedSince?: number;
  lastSeen: number;
}

const appName = (app: 'sonarr' | 'radarr') =>
  app === 'sonarr' ? 'Sonarr' : 'Radarr';

const errorText = (e: unknown): string => {
  if (typeof e === 'object' && e && 'response' in e) {
    const response = (e as { response?: { status?: number; data?: unknown } })
      .response;
    const data = response?.data as { message?: string } | string | undefined;
    const message =
      typeof data === 'string' ? data : (data?.message ?? undefined);
    if (message) return String(message).slice(0, 300);
    if (response?.status) return `HTTP ${response.status}`;
  }
  return e instanceof Error ? e.message.slice(0, 300) : String(e);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DownloadCheckEngine {
  private running = false;
  /** How long a stuck import is left to clear by itself (shorter in tests). */
  public blockedForMs = BLOCKED_FOR_MS;
  private seen = new Map<string, Seen>();
  /** Rows being acted on now, by the pass or by an admin. */
  private busy = new Set<number>();
  /** Which torrent client has which torrent, so it's asked once. */
  private holder = new Map<string, number>();
  private unreachable = new Set<string>();

  public status() {
    return { running: this.running };
  }

  /** Forgets what it saw of every download (tests start clean). */
  public forget() {
    this.seen.clear();
    this.holder.clear();
    this.unreachable.clear();
  }

  public mode(): DownloadCheckMode {
    return getSettings().backfill.downloadCheck?.mode ?? 'off';
  }

  /** Every Sonarr and Radarr, each address once. */
  private servers(): ServerRef[] {
    const settings = getSettings();
    const seen = new Set<string>();
    const out: ServerRef[] = [];
    const add = (app: 'sonarr' | 'radarr', list: DVRSettings[]) => {
      for (const s of list) {
        const address = `${app}|${s.hostname}|${s.port}|${s.baseUrl ?? ''}`;
        if (seen.has(address) || !s.apiKey) continue;
        seen.add(address);
        out.push({ app, settings: s as SonarrSettings & RadarrSettings });
      }
    };
    add('sonarr', settings.sonarr);
    add('radarr', settings.radarr);
    return out;
  }

  /** The server's API; a stand-in in tests. */
  public apiFor(ref: ServerRef): CheckServer {
    return ref.app === 'sonarr'
      ? CheckSonarr.forServer(ref.settings as SonarrSettings)
      : CheckRadarr.forServer(ref.settings as RadarrSettings);
  }

  /** One look at every queue. Does nothing while Download Check is off. */
  public async run(): Promise<void> {
    const mode = this.mode();
    if (mode === 'off' || this.running) return;
    this.running = true;
    try {
      // Every download in a queue this pass, by its key.
      const queued = new Set<string>();
      for (const ref of this.servers()) {
        const name = `${appName(ref.app)} ${ref.settings.name}`;
        try {
          await this.checkServer(ref, mode, queued);
          if (this.unreachable.delete(name)) {
            logger.info(`${name} is answering again`, { label: LABEL });
          }
        } catch (e) {
          // Said once, not every pass, while a server is down.
          if (!this.unreachable.has(name)) {
            this.unreachable.add(name);
            logger.warn(`Could not check ${name}'s queue`, {
              label: LABEL,
              errorMessage: errorText(e),
            });
          }
        }
      }
      // A download gone from every queue for an hour is forgotten.
      const cutoff = Date.now() - 3600_000;
      for (const [key, seen] of this.seen) {
        if (seen.lastSeen < cutoff) this.seen.delete(key);
      }
      // Which client holds a torrent, once it is in no queue.
      for (const hash of this.holder.keys()) {
        if (!queued.has(hash)) this.holder.delete(hash);
      }
    } finally {
      this.running = false;
    }
  }

  private async checkServer(
    ref: ServerRef,
    mode: DownloadCheckMode,
    queued: Set<string>
  ) {
    const server = this.apiFor(ref);
    const pass = new Pass(server);
    const grabs = await server.queue();
    const now = Date.now();
    const live = new Set<string>();

    for (const grab of grabs) {
      live.add(grab.key);
      queued.add(grab.key);
      const stage = stageOf(grab);
      if (!stage) continue;
      const memoKey = `${ref.app}:${ref.settings.id}:${grab.key}:${stage}`;
      const seen = this.seen.get(memoKey) ?? { lastSeen: now };
      seen.lastSeen = now;
      this.seen.set(memoKey, seen);

      const row = await getRepository(DownloadCheck).findOne({
        where: {
          app: ref.app,
          serverId: ref.settings.id,
          downloadKey: grab.key,
          stage,
        },
      });
      if (row) {
        // Found with Report only, and now on: done now, if it still applies.
        if (row.status === 'would' && mode === 'on') {
          await this.act(server, row, grab);
        }
        continue;
      }

      let decision: Decision | undefined;
      try {
        if (stage === 'grab') {
          decision = await this.checkGrab(pass, grab, grabs, seen);
        } else {
          seen.blockedSince ??= now;
          if (now - seen.blockedSince < this.blockedForMs) continue;
          decision = await this.checkImport(pass, grab);
        }
      } catch (e) {
        logger.debug(`Could not check ${grab.title}`, {
          label: LABEL,
          errorMessage: errorText(e),
        });
        continue;
      }
      if (!decision) continue;

      const saved = await this.record(ref, pass, grab, stage, decision);
      if (!saved) continue;
      logger.info(
        `${grab.title}: ${decision.finding} (${
          mode === 'report' && decision.action !== 'review'
            ? `would ${decision.action}`
            : decision.action
        })`,
        { label: LABEL, server: `${appName(ref.app)} ${ref.settings.name}` }
      );
      if (mode === 'on' && decision.action !== 'review') {
        await this.act(server, saved, grab);
      }
    }

    // Left the queue (imported, removed in Sonarr, cleaned up by another
    // tool) before anything was done.
    const open = await getRepository(DownloadCheck).find({
      where: {
        app: ref.app,
        serverId: ref.settings.id,
        status: In(['would', 'waiting'] satisfies CheckStatus[]),
      },
    });
    const gone = open.filter((r) => !live.has(r.downloadKey));
    if (gone.length) {
      await getRepository(DownloadCheck).update(
        { id: In(gone.map((r) => r.id)) },
        { status: 'gone', updatedAt: new Date() }
      );
    }
  }

  /** Before it's down: its name, timing, quality, place in the queue, files. */
  public async checkGrab(
    pass: Pass,
    grab: Grab,
    queue: Grab[],
    seen: Seen
  ): Promise<Decision | undefined> {
    if (!seen.named) {
      const named = await this.checkName(pass, grab, queue);
      // Looked at once it's been answered: a server not answering means
      // another look next time.
      seen.named = true;
      if (named) return named;
    }
    // A Usenet job's files aren't listed before it's down. A torrent's are
    // once its client has its file list: looked at then, and only then.
    if (!seen.filesLooked) {
      if (grab.protocol !== 'torrent') {
        seen.filesLooked = true;
        return undefined;
      }
      const files = await this.torrentFiles(grab);
      if (!files) return undefined;
      seen.filesLooked = true;
      const problem = checkFiles(files);
      if (problem) {
        return {
          finding: problem.code,
          action: 'reject',
          params: { files: problem.files },
        };
      }
    }
    return undefined;
  }

  /** Checks needing only the name and what the server has: done once. */
  private async checkName(
    pass: Pass,
    grab: Grab,
    queue: Grab[]
  ): Promise<Decision | undefined> {
    const server = pass.server;
    // An episode that hadn't aired: a fake named after it.
    if (server.app === 'sonarr' && grab.added) {
      const hours = hoursBeforeAir(
        new Date(grab.added).getTime(),
        grab.episodes.map((e) => e.airDateUtc)
      );
      if (hours !== undefined) {
        return { finding: 'early', action: 'reject', params: { hours } };
      }
    }

    // Grabbed on the indexer's id, under a name that isn't this title's.
    const parsed = await server.parsedItem(grab.title);
    if (parsed !== grab.itemId) {
      const evidence = await this.judge(pass, grab);
      if (evidence.verdict === 'different') {
        return {
          finding: 'otherTitle',
          action: 'reject',
          params: evidenceParams(evidence),
        };
      }
      if (evidence.verdict === 'renumbered' && evidence.episode?.hasFile) {
        // Another episode, one there's a file for already.
        return {
          finding: 'renumbered',
          action: 'reject',
          params: evidenceParams(evidence),
        };
      }
    }

    // Read as this series, but its episode title is another episode's:
    // Sonarr reads names by the scene's numbers (TheXEM), or the group
    // numbered it its own way. Left alone it goes in as the wrong episode.
    if (parsed === grab.itemId && server.app === 'sonarr') {
      const other = await this.titledAs(pass, grab);
      if (other) {
        return {
          finding: 'renumbered',
          action: 'reject',
          params: {
            reason: 'episodeTitle',
            episodeTitle: readEpisodeRelease(grab.title).episodeTitle,
            expected: grab.episodes[0].title,
            episode: {
              id: other.id,
              label: episodesLabel([other]),
              title: other.title,
              hasFile: other.hasFile,
            },
          },
        };
      }
    }

    // No better than what's there: the import would refuse it.
    const facts = await pass.facts(grab.itemId);
    const quality = grab.quality;
    if (quality) {
      const ranks = await pass.ranks(facts.qualityProfileId);
      const offered = { quality, customFormatScore: grab.customFormatScore };
      if (server.app === 'sonarr') {
        if (grab.episodes.length && grab.episodes.every((e) => e.hasFile)) {
          const files = await pass.files(grab.itemId);
          const all = await pass.episodes(grab.itemId);
          const filed = new Set(grab.episodes.map((e) => e.id));
          const held = grab.episodes.map((e) =>
            e.episodeFileId ? files.get(e.episodeFileId) : undefined
          );
          // The file there holds an episode this one doesn't.
          const wider = grab.episodes.flatMap((e) =>
            all.filter(
              (o) =>
                o.episodeFileId &&
                o.episodeFileId === e.episodeFileId &&
                !filed.has(o.id)
            )
          );
          if (wider.length) {
            return {
              finding: 'moreEpisodes',
              action: 'reject',
              params: { also: episodesLabel(wider) },
            };
          }
          if (held.every((h) => h)) {
            const verdicts = held.map((h) => isUpgrade(ranks, h!, offered));
            const refused = verdicts.find((v) => !v.upgrade);
            if (refused && verdicts.every((v) => !v.upgrade)) {
              return {
                finding: 'notUpgrade',
                action: 'reject',
                params: refused.upgrade ? {} : { ...refused },
              };
            }
          }
        }
      } else if (facts.movieFile) {
        const verdict = isUpgrade(ranks, facts.movieFile, offered);
        if (!verdict.upgrade) {
          return { finding: 'notUpgrade', action: 'reject', params: verdict };
        }
      }

      // A better copy of the same, further along: once it's in, this one
      // would be refused. (One that comes in first is replaced by the
      // better one after, which is no harm.)
      if (grab.sizeLeft > 0) {
        const mine = new Set(grab.episodes.map((e) => e.id));
        const better = queue.find(
          (other) =>
            other.key !== grab.key &&
            other.itemId === grab.itemId &&
            other.quality &&
            other.status !== 'delay' &&
            other.sizeLeft <= grab.sizeLeft &&
            (server.app === 'radarr' ||
              (mine.size > 0 &&
                [...mine].every((id) =>
                  other.episodes.some((e) => e.id === id)
                ))) &&
            compareGrabs(
              ranks,
              {
                quality: other.quality,
                customFormatScore: other.customFormatScore,
              },
              offered
            ) > 0
        );
        if (better) {
          return {
            finding: 'duplicate',
            action: 'drop',
            params: { better: better.title },
          };
        }
      }
    }
    return undefined;
  }

  /**
   * The other library episode a single-episode grab's title is, exactly,
   * when the name has one that isn't the episode it was filed as. Nothing
   * while that episode has no title yet ("TBA", as at air time), as the
   * name can't then be told from it.
   */
  private async titledAs(
    pass: Pass,
    grab: Grab
  ): Promise<QueueEpisode | undefined> {
    if (grab.episodes.length !== 1) return undefined;
    const filed = grab.episodes[0];
    if (
      !filed.title ||
      GENERIC_EPISODE.test(normalize(filed.title)) ||
      !readEpisodeRelease(grab.title).episodeTitle ||
      titleFits(grab.title, filed)
    ) {
      return undefined;
    }
    const other = episodeTitled(grab.title, await pass.episodes(grab.itemId));
    return other && other.id !== filed.id ? other : undefined;
  }

  private async judge(pass: Pass, grab: Grab): Promise<Evidence> {
    const facts = await pass.facts(grab.itemId);
    if (pass.server.app === 'radarr') {
      return judgeName(readMovieRelease(grab.title), facts);
    }
    const release = readEpisodeRelease(grab.title);
    const all =
      grab.episodes.length === 1 && release.episodeTitle
        ? await pass.episodes(grab.itemId)
        : [];
    return judgeName(release, facts, grab.episodes, all);
  }

  /** A torrent's files, once its client lists them; undefined before. */
  private async torrentFiles(
    grab: Grab
  ): Promise<{ name: string; size: number }[] | undefined> {
    if (grab.protocol !== 'torrent' || !grab.downloadId) return undefined;
    const hash = grab.downloadId.toLowerCase();
    const clients = getSettings().downloadClients.filter((c) =>
      isTorrentClient(c.type)
    );
    const known = this.holder.get(hash);
    const order = [
      ...clients.filter((c) => c.id === known),
      ...clients.filter((c) => c.id !== known),
    ];
    for (const settings of order) {
      let client: TorrentClient;
      try {
        client = torrentClientFor(settings);
        if (!(await client.findTorrent(hash))) continue;
      } catch {
        continue;
      }
      this.holder.set(hash, settings.id);
      const files = await client.getFiles(hash);
      return files.length ? files : undefined;
    }
    return undefined;
  }

  /** Once it's down and the import is stuck: what the server's reasons mean. */
  public async checkImport(pass: Pass, grab: Grab): Promise<Decision> {
    const problems = grab.messages.map(importProblemOf);
    const detail = grab.messages.join('\n').slice(0, 2000);
    const plan = planImport(problems);
    const main = (order: ImportProblem[]): CheckFinding =>
      (order.find((p) => problems.includes(p)) ?? 'unknown') as CheckFinding;

    switch (plan) {
      case 'reject':
        return {
          finding: main(['badFiles', 'moreEpisodes', 'notUpgrade']),
          action: 'reject',
          detail,
        };
      case 'clear':
        return {
          finding: main(['partial', 'alreadyImported']),
          action: 'clear',
          detail,
        };
      case 'import': {
        const files = await this.importFiles(pass, grab);
        if ('problem' in files) {
          return files.problem === 'not an upgrade'
            ? { finding: 'notUpgrade', action: 'reject', detail }
            : { finding: 'unmapped', action: 'review', detail };
        }
        return {
          finding: main(['xem', 'unparsed', 'sampleUnsure']),
          action: 'import',
          detail,
        };
      }
      case 'byName': {
        const evidence = await this.judge(pass, grab);
        const params = evidenceParams(evidence);
        if (evidence.verdict === 'different') {
          return { finding: 'otherTitle', action: 'reject', params, detail };
        }
        if (evidence.verdict === 'renumbered' && evidence.episode) {
          if (evidence.episode.hasFile) {
            return { finding: 'renumbered', action: 'reject', params, detail };
          }
          const files = await this.importFiles(pass, grab, evidence.episode.id);
          return 'problem' in files
            ? { finding: 'unmapped', action: 'review', params, detail }
            : { finding: 'renumbered', action: 'import', params, detail };
        }
        if (evidence.verdict === 'same') {
          const files = await this.importFiles(pass, grab);
          if (!('problem' in files)) {
            return { finding: 'sameTitle', action: 'import', params, detail };
          }
          return files.problem === 'not an upgrade'
            ? { finding: 'notUpgrade', action: 'reject', params, detail }
            : { finding: 'unmapped', action: 'review', params, detail };
        }
        return { finding: 'unsureTitle', action: 'review', params, detail };
      }
      default:
        return { finding: 'unknown', action: 'review', detail };
    }
  }

  /**
   * The files to import and what each one is. Sonarr's own reading of each
   * file first; a single episode's one real video is that episode; a file
   * read as an episode it wasn't grabbed for, or a file nobody can place,
   * stops it. A file no better than the one there is left out, as an import
   * that's told what a file is goes ahead even when it's worse.
   */
  public async importFiles(
    pass: Pass,
    grab: Grab,
    episodeId?: number
  ): Promise<{ files: ImportFile[] } | { problem: string }> {
    const server = pass.server;
    if (!grab.downloadId) return { problem: 'no download' };
    const candidates = (
      await server.candidates(grab.downloadId, grab.itemId)
    ).filter((c) => c.size >= SAMPLE_BYTES);
    if (!candidates.length) return { problem: 'no video' };
    const facts = await pass.facts(grab.itemId);
    const ranks = await pass.ranks(facts.qualityProfileId);
    const quality = (c: ImportCandidate) => c.quality ?? grab.quality;

    if (server.app === 'radarr') {
      const biggest = [...candidates].sort((a, b) => b.size - a.size)[0];
      const q = quality(biggest);
      if (!q) return { problem: 'no quality' };
      if (
        facts.movieFile &&
        !isUpgrade(ranks, facts.movieFile, {
          quality: q,
          customFormatScore:
            biggest.customFormatScore ?? grab.customFormatScore,
        }).upgrade
      ) {
        return { problem: 'not an upgrade' };
      }
      return {
        files: [
          {
            ...biggest,
            quality: q,
            itemId: grab.itemId,
            downloadId: grab.downloadId,
          },
        ],
      };
    }

    const filed = new Set(grab.episodes.map((e) => e.id));
    const placed: ImportFile[] = [];
    for (const c of candidates) {
      let ids = c.episodeIds;
      if (episodeId !== undefined) {
        if (candidates.length !== 1) return { problem: 'several files' };
        ids = [episodeId];
      } else if (!ids.length) {
        if (filed.size !== 1 || candidates.length !== 1) {
          return { problem: 'unplaced file' };
        }
        ids = [...filed];
      } else if (!ids.every((id) => filed.has(id))) {
        return { problem: 'another episode' };
      }
      const q = quality(c);
      if (!q) return { problem: 'no quality' };
      placed.push({
        ...c,
        episodeIds: ids,
        quality: q,
        itemId: grab.itemId,
        downloadId: grab.downloadId,
      });
    }

    // Left out where the episode's file is better already.
    const files = await pass.files(grab.itemId);
    const all = await pass.episodes(grab.itemId);
    const kept = placed.filter((f) =>
      f.episodeIds.every((id) => {
        const episode = all.find((e) => e.id === id);
        const held = episode?.episodeFileId
          ? files.get(episode.episodeFileId)
          : undefined;
        return (
          !held ||
          isUpgrade(ranks, held, {
            quality: f.quality!,
            customFormatScore: f.customFormatScore ?? grab.customFormatScore,
          }).upgrade
        );
      })
    );
    return kept.length ? { files: kept } : { problem: 'not an upgrade' };
  }

  private async record(
    ref: ServerRef,
    pass: Pass,
    grab: Grab,
    stage: CheckStage,
    decision: Decision
  ): Promise<DownloadCheck | undefined> {
    let facts: ItemFacts | undefined;
    try {
      facts = await pass.facts(grab.itemId);
    } catch {
      facts = undefined;
    }
    const now = new Date();
    const row = new DownloadCheck({
      app: ref.app,
      serverId: ref.settings.id,
      downloadKey: grab.key,
      stage,
      title: grab.title.slice(0, 500),
      itemId: grab.itemId,
      itemTitle: (facts?.title ?? grab.title).slice(0, 300),
      episodes: episodesLabel(grab.episodes),
      poster: facts?.poster ?? null,
      finding: decision.finding,
      action: decision.action,
      // 'would' until it's done: with Report only on, for good.
      status: decision.action === 'review' ? 'waiting' : 'would',
      params: JSON.stringify(decision.params ?? {}),
      detail: decision.detail ?? '',
      createdAt: now,
      updatedAt: now,
    });
    try {
      return await getRepository(DownloadCheck).save(row);
    } catch {
      // Recorded already, by an admin's action at the same moment.
      return undefined;
    }
  }

  /** Does what a row says, now. Answers the row as it ends up. */
  public async act(
    server: CheckServer,
    row: DownloadCheck,
    grab: Grab,
    action: CheckAction = row.action
  ): Promise<DownloadCheck> {
    if (this.busy.has(row.id)) return row;
    this.busy.add(row.id);
    const repo = getRepository(DownloadCheck);
    try {
      const pass = new Pass(server);
      if (action === 'reject') {
        const missing = await this.anyMissing(pass, grab);
        // A release numbered another way comes back to a search by that
        // number, from another indexer or another post of it: Backfill,
        // which reads names by their episode titles, looks instead.
        const renumbered =
          server.app === 'sonarr' && row.finding === 'renumbered';
        await server.remove(grab.queueIds, {
          removeFromClient: true,
          blocklist: true,
          // Searched again only for what's still missing: a download that
          // was no better than the file there needs no replacement.
          skipRedownload: renumbered || !missing,
        });
        // The reject is done whatever becomes of this.
        const looking =
          renumbered &&
          (await this.lookByTitle(row, missing).catch((e: unknown) => {
            logger.warn('Could not start a Backfill search', {
              label: LABEL,
              errorMessage: errorText(e),
            });
            return false;
          }));
        const after: RejectAfter = looking
          ? 'byTitle'
          : !missing
            ? 'none'
            : renumbered
              ? 'noSearch'
              : 'search';
        row.params = JSON.stringify({
          ...(JSON.parse(row.params || '{}') as object),
          after,
        });
      } else if (action === 'drop') {
        await server.remove(grab.queueIds, {
          removeFromClient: true,
          blocklist: false,
          skipRedownload: true,
        });
      } else if (action === 'clear') {
        await server.remove(grab.queueIds, {
          removeFromClient: false,
          blocklist: false,
          skipRedownload: true,
        });
        // What it was meant to bring and didn't, searched for.
        if (server.app === 'sonarr') {
          await server.search(
            grab.itemId,
            await this.missingEpisodes(pass, grab)
          );
        } else if (await this.anyMissing(pass, grab)) {
          await server.search(grab.itemId, []);
        }
      } else if (action === 'import') {
        const params = JSON.parse(row.params || '{}') as {
          episode?: { id: number };
        };
        const planned = await this.importFiles(
          pass,
          grab,
          row.finding === 'renumbered' ? params.episode?.id : undefined
        );
        if ('problem' in planned) {
          throw new Error(importProblemText(planned.problem));
        }
        const id = await server.manualImport(planned.files);
        const ended = await this.follow(server, id);
        if (ended.status !== 'completed') {
          throw new Error(
            ended.message ||
              (ended.status === 'started' || ended.status === 'queued'
                ? 'The import is still running.'
                : `The import ${ended.status}.`)
          );
        }
      } else {
        return row;
      }
      row.status = 'done';
      row.action = action;
      row.error = null;
    } catch (e) {
      row.status = 'failed';
      row.action = action;
      row.error = errorText(e);
      logger.warn(`Could not ${action} ${row.title}`, {
        label: LABEL,
        errorMessage: row.error,
      });
    } finally {
      this.busy.delete(row.id);
    }
    row.updatedAt = new Date();
    return repo.save(row);
  }

  /**
   * A release turned down for being another episode: Backfill looks for
   * what's still missing (the episode it was grabbed as, or the one it
   * is), as it reads names by their episode titles where Sonarr can't.
   * Answers whether Backfill looks, now or lately.
   */
  private async lookByTitle(
    row: DownloadCheck,
    grabbedMissing: boolean
  ): Promise<boolean> {
    if (!getSettings().backfill.enabled) return false;
    const params = JSON.parse(row.params || '{}') as {
      episode?: { hasFile?: boolean };
    };
    const itsOwnMissing = !!params.episode && !params.episode.hasFile;
    if (!grabbedMissing && !itsOwnMissing) return false;
    const title = await getRepository(BackfillSeries).findOne({
      select: { id: true, status: true, lastSearchedAt: true },
      where: { kind: 'series', serverId: row.serverId, arrId: row.itemId },
    });
    if (!title || title.status === 'ignored') return false;
    // Once in a while, however many such grabs a title gets.
    if (
      title.lastSearchedAt &&
      Date.now() - title.lastSearchedAt.getTime() < LOOK_AGAIN_MS
    ) {
      return true;
    }
    backfill.startSearch(title.id);
    return true;
  }

  private async follow(server: CheckServer, id: number) {
    const until = Date.now() + IMPORT_WAIT_MS;
    let last = await server.command(id);
    while (
      !['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(
        last.status
      ) &&
      Date.now() < until
    ) {
      await sleep(IMPORT_POLL_MS);
      last = await server.command(id);
    }
    return last;
  }

  /** The grab's episodes still without a file, as the server has them now. */
  private async missingEpisodes(pass: Pass, grab: Grab): Promise<number[]> {
    if (pass.server.app !== 'sonarr' || !grab.episodes.length) return [];
    const ids = new Set(grab.episodes.map((e) => e.id));
    return (await pass.episodes(grab.itemId))
      .filter((e) => ids.has(e.id) && !e.hasFile)
      .map((e) => e.id);
  }

  private async anyMissing(pass: Pass, grab: Grab): Promise<boolean> {
    if (pass.server.app === 'radarr') {
      return !(await pass.facts(grab.itemId)).movieFile;
    }
    return (await this.missingEpisodes(pass, grab)).length > 0;
  }

  /**
   * An admin's choice for a row: do what it says, import or reject it
   * instead, or leave it alone. Acting needs the download still queued.
   */
  public async decide(
    id: number,
    choice: CheckAction | 'dismiss'
  ): Promise<DownloadCheck> {
    const repo = getRepository(DownloadCheck);
    const row = await repo.findOneOrFail({ where: { id } });
    if (choice === 'dismiss') {
      row.status = 'dismissed';
      row.updatedAt = new Date();
      return repo.save(row);
    }
    if (choice === 'review') return row;
    const ref = this.servers().find(
      (s) => s.app === row.app && s.settings.id === row.serverId
    );
    if (!ref) throw new DecideError(`That ${appName(row.app)} server is gone.`);
    const server = this.apiFor(ref);
    const grab = (await server.queue()).find((g) => g.key === row.downloadKey);
    if (!grab) {
      row.status = 'gone';
      row.updatedAt = new Date();
      await repo.save(row);
      throw new DecideError(`It's no longer in ${appName(row.app)}'s queue.`);
    }
    if (choice === 'import' && row.stage !== 'import') {
      throw new DecideError('It can be imported once it has downloaded.');
    }
    return this.act(server, row, grab, choice);
  }
}

export class DecideError extends Error {}

const importProblemText = (problem: string): string =>
  ({
    'no download': 'The download client has no id for it yet.',
    'no video': 'There’s no video file in it to import.',
    'no quality': 'Its quality can’t be read.',
    'not an upgrade': 'It’s no better than the file there.',
    'several files': 'It has more than one video file.',
    'unplaced file': 'Which episode each file is can’t be told.',
    'another episode': 'A file in it is an episode it wasn’t grabbed for.',
  })[problem] ?? problem;

/** What a judgement shows: what the name says, and what decided it. */
const evidenceParams = (evidence: Evidence): Record<string, unknown> => ({
  reason: evidence.reason,
  named: evidence.named,
  episodeTitle: evidence.episodeTitle,
  expected: evidence.expected,
  episode: evidence.episode
    ? {
        id: evidence.episode.id,
        label: episodesLabel([evidence.episode]),
        title: evidence.episode.title,
        hasFile: evidence.episode.hasFile,
      }
    : undefined,
});

const downloadCheck = new DownloadCheckEngine();

export default downloadCheck;
