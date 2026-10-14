import MusicBrainz, {
  MB_LIFETIMES,
  MB_SPACING_MS,
  isMbid,
  isPublicMusicBrainz,
  musicBrainz,
  musicBrainzUserAgent,
  plainText,
} from '@server/api/musicbrainz';
import {
  MusicBrainzBusyError,
  RequestQueue,
} from '@server/api/musicbrainz/queue';
import { getRepository } from '@server/datasource';
import MusicMetadata from '@server/entity/MusicMetadata';
import cacheManager from '@server/lib/cache';
import { getSettings, musicDefaults } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { getAppVersion } from '@server/utils/appVersion';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * MusicBrainz allows one request a second from an address. Everything Seerr
 * asks it goes through one queue, and what comes back is kept in memory and
 * in the database.
 */

const ARTIST = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
const ALBUM = '1b022e01-4da6-387b-8658-8678046e4cef';
const RELEASE = 'b84ee12a-09ef-421b-82de-0441a926375b';
const OTHER_RELEASE = '2d5e5c7c-3b9a-4b6f-8a50-6bd25a3b2a33';

/** A clock the queue sleeps on: sleeping moves it forward. */
const fakeClock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the MusicBrainz queue', () => {
  it('starts requests at least the spacing apart', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 60_000,
      ...clock,
    });
    const starts: number[] = [];
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((key) =>
        queue.add(key, 'interactive', async () => {
          starts.push(clock.now());
          return key;
        })
      )
    );
    assert.equal(starts.length, 4);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i - 1] >= MB_SPACING_MS);
    }
    assert.ok(starts[3] - starts[0] >= 3 * MB_SPACING_MS);
  });

  it('makes the same request once while it waits', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 60_000,
      ...clock,
    });
    let calls = 0;
    const run = async () => {
      calls++;
      return 'answer';
    };
    const answers = await Promise.all([
      queue.add('same', 'interactive', run),
      queue.add('same', 'interactive', run),
      queue.add('same', 'background', run),
    ]);
    assert.deepEqual(answers, ['answer', 'answer', 'answer']);
    assert.equal(calls, 1);
  });

  it('serves people before background work', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 60_000,
      ...clock,
    });
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
    };
    const all = [
      queue.add('scan-1', 'background', job('scan-1')),
      queue.add('scan-2', 'background', job('scan-2')),
      queue.add('scan-3', 'background', job('scan-3')),
      queue.add('page', 'interactive', job('page')),
      // A person now waits on what a scan asked for: it moves up too.
      queue.add('scan-3', 'interactive', job('scan-3')),
    ];
    await Promise.all(all);
    assert.deepEqual(order, ['scan-1', 'page', 'scan-3', 'scan-2']);
  });

  it('tells a person it is busy rather than keep them waiting', async () => {
    const clock = fakeClock();
    // A clock that does not move: everything stays queued.
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 8000,
      now: clock.now,
      sleep: () => new Promise(() => undefined),
    });
    const never = () => new Promise<void>(() => undefined);
    // One under way, then enough waiting to pass eight seconds.
    for (let i = 0; i < 8; i++) {
      void queue.add(`page-${i}`, 'interactive', never);
    }
    await settle();
    await assert.rejects(
      queue.add('one-more', 'interactive', never),
      MusicBrainzBusyError
    );
    // A scan just waits its turn.
    const scan = queue.add('scan', 'background', never);
    assert.ok(scan instanceof Promise);
    assert.equal(queue.size, 9);
  });

  it('backs off on a 503 and tries once more, then gives up', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 60_000,
      ...clock,
    });
    const overLimit = () => ({
      response: { status: 503, headers: { 'retry-after': '5' } },
    });

    const starts: number[] = [];
    let attempts = 0;
    const answer = await queue.add('flaky', 'interactive', async () => {
      starts.push(clock.now());
      if (attempts++ === 0) {
        throw overLimit();
      }
      return 'ok';
    });
    assert.equal(answer, 'ok');
    assert.equal(attempts, 2);
    assert.ok(starts[1] - starts[0] >= 5000);

    let tries = 0;
    await assert.rejects(
      queue.add('down', 'interactive', async () => {
        tries++;
        throw overLimit();
      }),
      (e: { response?: { status?: number } }) => e.response?.status === 503
    );
    assert.equal(tries, 2);
  });
});

describe('how the MusicBrainz queue has fared, for Health', () => {
  it('counts 503s, failures and people turned away, and failures in a row', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 60_000,
      ...clock,
    });
    const overLimit = () => ({ response: { status: 503, headers: {} } });

    // Over the limit twice: tried again, then given up.
    await assert.rejects(
      queue.add('down', 'interactive', async () => {
        throw overLimit();
      })
    );
    await assert.rejects(
      queue.add('timeout', 'background', async () => {
        throw new Error('timeout of 15000ms exceeded');
      })
    );
    // No such thing is an answer, not a failure.
    await assert.rejects(
      queue.add('missing', 'interactive', async () => {
        throw { response: { status: 404 } };
      })
    );
    let health = queue.health();
    assert.equal(health.rateLimited, 2);
    assert.equal(health.failed, 2);
    assert.equal(health.failingInARow, 0);
    assert.equal(health.lastError, 'timeout of 15000ms exceeded');

    await assert.rejects(
      queue.add('again', 'interactive', async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      })
    );
    assert.equal(queue.health().failingInARow, 1);
    await queue.add('fine', 'interactive', async () => 'ok');
    health = queue.health();
    assert.equal(health.failingInARow, 0);
    assert.equal(health.lastSuccessAt, clock.now());

    // An hour on, it is all forgotten.
    await clock.sleep(60 * 60 * 1000);
    health = queue.health();
    assert.deepEqual(
      [health.rateLimited, health.failed, health.busy],
      [0, 0, 0]
    );
  });

  it('counts people told it was busy', async () => {
    const clock = fakeClock();
    const queue = new RequestQueue({
      spacingMs: () => MB_SPACING_MS,
      maxWaitMs: 8000,
      now: clock.now,
      sleep: () => new Promise(() => undefined),
    });
    const never = () => new Promise<void>(() => undefined);
    for (let i = 0; i < 8; i++) {
      void queue.add(`page-${i}`, 'interactive', never);
    }
    await settle();
    await assert.rejects(queue.add('one-more', 'interactive', never));
    await assert.rejects(queue.add('two-more', 'interactive', never));
    assert.equal(queue.health().busy, 2);
    assert.equal(queue.health().waiting, 8);
  });
});

describe('the MusicBrainz client', () => {
  setupTestDb();

  const getAxios = (client: MusicBrainz): AxiosInstance =>
    (client as unknown as { axios: AxiosInstance }).axios;

  /** A client whose requests answer from `answers`, by path. */
  const stubbed = (answers: Record<string, unknown>) => {
    const client = new MusicBrainz({ baseUrl: 'http://mirror.local:5000' });
    const get = mock.method(getAxios(client), 'get', async (path: string) => {
      if (!(path in answers)) {
        throw new Error(`Unexpected request: ${path}`);
      }
      return { data: answers[path] };
    });
    return { client, get };
  };

  beforeEach(() => {
    // A mirror: not spaced, so the tests do not wait a second a request.
    getSettings().music = {
      ...musicDefaults(),
      musicbrainzUrl: 'http://mirror.local:5000',
    };
    cacheManager.getCache('musicbrainz').flush();
  });

  afterEach(() => {
    mock.restoreAll();
    getSettings().music = musicDefaults();
  });

  it('names itself the way MusicBrainz asks', () => {
    const version = getAppVersion();
    assert.equal(
      musicBrainzUserAgent(),
      `SeerrAI/${version} ( https://github.com/corruptmods/SeerrAI )`
    );
    assert.equal(
      musicBrainzUserAgent(' admin@example.com '),
      `SeerrAI/${version} ( https://github.com/corruptmods/SeerrAI; admin@example.com )`
    );
    const client = new MusicBrainz({ contactEmail: 'admin@example.com' });
    assert.equal(
      getAxios(client).defaults.headers['User-Agent'],
      musicBrainzUserAgent('admin@example.com')
    );
  });

  it('spaces requests to the public server only', () => {
    assert.equal(isPublicMusicBrainz('https://musicbrainz.org'), true);
    assert.equal(isPublicMusicBrainz('https://beta.musicbrainz.org/'), true);
    assert.equal(isPublicMusicBrainz('http://192.168.1.5:5000'), false);
  });

  it('is one client for the server, made again when its settings change', () => {
    const first = musicBrainz();
    assert.equal(musicBrainz(), first);
    getSettings().music = {
      ...getSettings().music,
      contactEmail: 'admin@example.com',
    };
    assert.notEqual(musicBrainz(), first);
  });

  it('asks once, then answers from memory and from the database', async () => {
    const { client, get } = stubbed({
      [`/ws/2/artist/${ARTIST}`]: { id: ARTIST, name: 'Radiohead' },
    });

    assert.equal((await client.getArtist(ARTIST)).name, 'Radiohead');
    assert.equal((await client.getArtist(ARTIST)).name, 'Radiohead');
    assert.equal(get.mock.callCount(), 1);
    const [, config] = get.mock.calls[0].arguments as [
      string,
      { params: Record<string, string> },
    ];
    assert.equal(config.params.fmt, 'json');
    assert.equal(config.params.inc, 'url-rels+genres+aliases');

    const row = await getRepository(MusicMetadata).findOneOrFail({
      where: { key: `artist:${ARTIST}` },
    });
    assert.equal(JSON.parse(row.data).name, 'Radiohead');
    const lifetime = new Date(row.expiresAt!).getTime() - Date.now();
    assert.ok(lifetime > MB_LIFETIMES.artist - 60_000);

    // After a restart: memory is empty, the database still has it.
    cacheManager.getCache('musicbrainz').flush();
    assert.equal((await client.getArtist(ARTIST)).name, 'Radiohead');
    assert.equal(get.mock.callCount(), 1);
  });

  it('serves an answer past its time while fetching it again', async () => {
    await getRepository(MusicMetadata).save(
      new MusicMetadata({
        key: `artist:${ARTIST}`,
        data: JSON.stringify({ id: ARTIST, name: 'Old Name' }),
        fetchedAt: new Date(Date.now() - 10 * 86400_000),
        expiresAt: new Date(Date.now() - 86400_000),
      })
    );
    const { client, get } = stubbed({
      [`/ws/2/artist/${ARTIST}`]: { id: ARTIST, name: 'New Name' },
    });

    assert.equal((await client.getArtist(ARTIST)).name, 'Old Name');
    let name = '';
    for (let i = 0; i < 20 && name !== 'New Name'; i++) {
      await settle();
      name = (await client.getArtist(ARTIST)).name;
    }
    assert.equal(name, 'New Name');
    assert.equal(get.mock.callCount(), 1);
  });

  it('keeps which album a release belongs to for good', async () => {
    const { client } = stubbed({
      [`/ws/2/release/${RELEASE}`]: {
        id: RELEASE,
        title: 'OK Computer',
        'release-group': { id: ALBUM, title: 'OK Computer' },
      },
    });
    assert.equal(await client.getReleaseGroupOfRelease(RELEASE), ALBUM);
    const row = await getRepository(MusicMetadata).findOneOrFail({
      where: { key: `release-rg:${RELEASE}` },
    });
    assert.equal(row.expiresAt, null);
  });

  it('reads the track list from the earliest official release', async () => {
    const { client, get } = stubbed({
      [`/ws/2/release-group/${ALBUM}`]: {
        id: ALBUM,
        title: 'OK Computer',
        releases: [
          { id: OTHER_RELEASE, title: 'OK Computer', status: 'Bootleg' },
          {
            id: 'c0f7b5c4-1111-4b6f-8a50-6bd25a3b2a33',
            title: 'OK Computer',
            status: 'Official',
            date: '2009-08-31',
          },
          {
            id: RELEASE,
            title: 'OK Computer',
            status: 'Official',
            date: '1997-05-21',
          },
        ],
      },
      [`/ws/2/release/${RELEASE}`]: {
        id: RELEASE,
        title: 'OK Computer',
        media: [
          {
            position: 1,
            tracks: [{ id: 't1', position: 1, title: 'Airbag' }],
          },
        ],
      },
    });
    const media = await client.getTracks(ALBUM);
    assert.equal(media[0].tracks?.[0].title, 'Airbag');
    assert.deepEqual(
      get.mock.calls.map((c) => c.arguments[0]),
      [`/ws/2/release-group/${ALBUM}`, `/ws/2/release/${RELEASE}`]
    );
  });

  it('asks for an artist’s albums a page at a time, by kind', async () => {
    const { client, get } = stubbed({
      '/ws/2/release-group': {
        'release-group-count': 1,
        'release-group-offset': 100,
        'release-groups': [],
      },
    });
    await client.getArtistReleaseGroups(ARTIST, {
      types: ['EP', 'album'],
      page: 1,
    });
    const [, config] = get.mock.calls[0].arguments as [
      string,
      { params: Record<string, string | number> },
    ];
    assert.equal(config.params.artist, ARTIST);
    assert.equal(config.params.type, 'album|ep');
    assert.equal(config.params.limit, 100);
    assert.equal(config.params.offset, 100);
    assert.ok(
      await getRepository(MusicMetadata).findOne({
        where: { key: `rg-list:${ARTIST}:album|ep:1` },
      })
    );
  });

  it('keeps searches in memory only', async () => {
    const { client, get } = stubbed({
      '/ws/2/artist': { count: 1, offset: 0, artists: [{ id: ARTIST }] },
    });
    await client.searchArtists('Radiohead');
    await client.searchArtists(' radiohead ');
    assert.equal(get.mock.callCount(), 1);
    assert.equal(await getRepository(MusicMetadata).count(), 0);
  });

  it('refuses anything but a MusicBrainz id, without asking', async () => {
    const { client, get } = stubbed({});
    assert.equal(isMbid(ARTIST), true);
    assert.equal(isMbid('../../admin'), false);
    await assert.rejects(client.getArtist('../../admin'), /Not a MusicBrainz/);
    assert.equal(get.mock.callCount(), 0);
  });

  it('turns the Wikipedia extract into plain text', async () => {
    assert.equal(
      plainText('<p>Radiohead are an <b>English</b> rock band &amp; more.</p>'),
      'Radiohead are an English rock band & more.'
    );
    const { client } = stubbed({
      [`/artist/${ARTIST}/wikipedia-extract`]: {
        wikipediaExtract: { content: '<p>A band.</p>' },
      },
    });
    assert.equal(await client.getWikipediaExtract(ARTIST), 'A band.');
  });
});
