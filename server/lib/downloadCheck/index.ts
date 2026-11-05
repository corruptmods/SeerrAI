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
 * Download Check: twice a minute, checks every download in Sonarr's and
 * Radarr's queues for anything that would block its import or shows it
 * isn't what it claims.
 *
 * While downloading (or held by a delay profile): a program among its
 * files, only archives or samples, an episode not yet aired, another show
 * or version under this one's name, no better than the existing file, or a
 * better copy already queued. Once downloaded with the import stuck, it
 * reads the server's reason: imports with the actual episodes when the name
 * shows the right title, rejects and searches again when nothing usable is
 * in it, or leaves it for an admin when undecidable.
 *
 * Report only logs what it would do and acts on nothing. No AI is used:
 * every decision is a rule over what the servers report.
 */

const LABEL = 'Download Check';

/** How long a stuck import gets to clear by itself before acting. */
export const BLOCKED_FOR_MS = 2 * 60_000;

/** How long to poll an import before treating it as started but unfinished. */
const IMPORT_WAIT_MS = 90_000;
const IMPORT_POLL_MS = 3_000;
/** Min gap between Backfill searches a renumbered grab can start for a title. */
const LOOK_AGAIN_MS = 6 * 60 * 60 * 1000;

/** Download states before completion. */
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
  /** The server's message, for a stuck import. */
  detail?: string;
}

export interface ServerRef {
  app: 'sonarr' | 'radarr';
  settings: SonarrSettings | RadarrSettings;
}

/** Whether a download is still downloading, or done and stuck. */
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

/** Per-pass cache so each server is asked each question once. */
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
      // Failures aren't cached; the next call asks again.
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

/** In-memory state of a download between passes. */
interface Seen {
  /** Its name, timing and quality have been checked. */
  named?: boolean;
  /** Its files have been checked (torrents, once the client lists them). */
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
  /** Rows being acted on, by the pass or an admin. */
  private busy = new Set<number>();
  /** Torrent hash → client holding it, so each is looked up once. */
  private holder = new Map<string, number>();
  private unreachable = new Set<string>();

  public status() {
    return { running: this.running };
  }

  /** Clears all download state (tests start clean). */
  public forget() {
    this.seen.clear();
    this.holder.clear();
    this.unreachable.clear();
  }

  public mode(): DownloadCheckMode {
    return getSettings().backfill.downloadCheck?.mode ?? 'off';
  }

  /** Every Sonarr and Radarr, deduplicated by address. */
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

  /** The server's API; replaced in tests. */
  public apiFor(ref: ServerRef): CheckServer {
    return ref.app === 'sonarr'
      ? CheckSonarr.forServer(ref.settings as SonarrSettings)
      : CheckRadarr.forServer(ref.settings as RadarrSettings);
  }

  /** One pass over every queue. Does nothing while Download Check is off. */
  public async run(): Promise<void> {
    const mode = this.mode();
    if (mode === 'off' || this.running) return;
    this.running = true;
    try {
      // Keys of every download queued this pass.
      const queued = new Set<string>();
      for (const ref of this.servers()) {
        const name = `${appName(ref.app)} ${ref.settings.name}`;
        try {
          await this.checkServer(ref, mode, queued);
          if (this.unreachable.delete(name)) {
            logger.info(`${name} is answering again`, { label: LABEL });
          }
        } catch (e) {
          // Logged once while a server is down, not every pass.
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
      // Drop client lookups for torrents no longer queued.
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
        // Found under Report only and now on: act if it still applies.
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

    // Mark rows gone whose download left the queue (imported, removed in
    // Sonarr, cleaned up by another tool) before anything was done.
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

  /** While downloading: checks name, timing, quality, queue and files. */
  public async checkGrab(
    pass: Pass,
    grab: Grab,
    queue: Grab[],
    seen: Seen
  ): Promise<Decision | undefined> {
    if (!seen.named) {
      const named = await this.checkName(pass, grab, queue);
      // Marked only after the server answered; otherwise retried next pass.
      seen.named = true;
      if (named) return named;
    }
    // Usenet files aren't listed until downloaded. Torrent files are checked
    // once, when the client first lists them.
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

  /** One-time checks needing only the name and the server's data. */
  private async checkName(
    pass: Pass,
    grab: Grab,
    queue: Grab[]
  ): Promise<Decision | undefined> {
    const server = pass.server;
    // Grabbed before the episode aired: a fake named after it.
    if (server.app === 'sonarr' && grab.added) {
      const hours = hoursBeforeAir(
        new Date(grab.added).getTime(),
        grab.episodes.map((e) => e.airDateUtc)
      );
      if (hours !== undefined) {
        return { finding: 'early', action: 'reject', params: { hours } };
      }
    }

    // Grabbed by indexer id under a name that isn't this title's.
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
        // Another episode that already has a file.
        return {
          finding: 'renumbered',
          action: 'reject',
          params: evidenceParams(evidence),
        };
      }
    }

    // Parsed as this series but titled as another episode: Sonarr uses scene
    // numbering (TheXEM), or the group numbered it its own way. Left alone
    // it imports as the wrong episode.
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

    // No better than the existing file: the import would refuse it.
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
          // The existing file holds an episode this one doesn't.
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

      // A better copy further along would make the import refuse this one.
      // (If this one lands first, the better one replaces it; no harm.)
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
   * The other library episode whose title exactly matches a single-episode
   * grab's episode title, if it isn't the one it was filed as. Undefined
   * while the filed episode is untitled ("TBA" at air time), since the name
   * can't be told from it.
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

  /** A torrent's files once its client lists them; undefined before. */
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

  /** Downloaded with a stuck import: decides from the server's reasons. */
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
   * The files to import and what each is. Uses Sonarr's parse of each file
   * first; a single-episode grab's one real video is that episode. A file
   * parsed as an episode it wasn't grabbed for, or one nobody can place,
   * stops it. Files no better than the existing one are left out, since an
   * import told what a file is proceeds even when it's worse.
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

    // Skip episodes whose existing file is already better.
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
      // 'would' until acted on; permanent under Report only.
      status: decision.action === 'review' ? 'waiting' : 'would',
      params: JSON.stringify(decision.params ?? {}),
      detail: decision.detail ?? '',
      createdAt: now,
      updatedAt: now,
    });
    try {
      return await getRepository(DownloadCheck).save(row);
    } catch {
      // Already recorded by a concurrent admin action.
      return undefined;
    }
  }

  /** Carries out a row's action now. Returns the updated row. */
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
        // A search by number would find the renumbered release again (from
        // another indexer or post), so Backfill, which matches episode
        // titles, searches instead.
        const renumbered =
          server.app === 'sonarr' && row.finding === 'renumbered';
        await server.remove(grab.queueIds, {
          removeFromClient: true,
          blocklist: true,
          // Search only for what's still missing; a download no better than
          // the existing file needs no replacement.
          skipRedownload: renumbered || !missing,
        });
        // The reject stands even if this fails.
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
        // Search for what it was meant to bring and didn't.
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
   * After rejecting a release for being another episode, has Backfill search
   * for what's still missing (the episode it was grabbed as, or the one it
   * is), since Backfill matches episode titles where Sonarr can't. Returns
   * whether Backfill searches now or did recently.
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
    // At most once per LOOK_AGAIN_MS, however many such grabs a title gets.
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

  /** The grab's episodes still without a file on the server. */
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
   * An admin's choice for a row: carry out its action, import or reject
   * instead, or leave it. Acting requires the download to still be queued.
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

/** A verdict's evidence for display: what the name says and what decided it. */
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
