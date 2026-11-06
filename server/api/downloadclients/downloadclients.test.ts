import QBittorrentAPI, {
  qbitDownload,
} from '@server/api/downloadclients/qbittorrent';
import SabnzbdAPI, {
  sabHistoryDownload,
  sabQueueDownload,
  sabSecondsLeft,
} from '@server/api/downloadclients/sabnzbd';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it, mock } from 'node:test';

const MB = 1024 * 1024;
/** A SABnzbd 4.2+ job id, as Radarr records it. */
const UUID_JOB = 'a0390606-07de-47d6-8877-46f3ceed243c';

describe('SABnzbd, read directly', () => {
  it('reads its time left, days and all', () => {
    assert.equal(sabSecondsLeft('0:12:34'), 754);
    assert.equal(sabSecondsLeft('1:02:03:04'), 93_784);
    assert.equal(sabSecondsLeft('0:00:00'), undefined);
    assert.equal(sabSecondsLeft(undefined), undefined);
  });

  it('says where a job in its queue stands', () => {
    const slot = { mb: '1000', mbleft: '250', timeleft: '0:05:00' };
    assert.deepEqual(
      sabQueueDownload({ ...slot, nzo_id: 'a', status: 'Downloading' }, false),
      {
        size: 1000 * MB,
        sizeLeft: 250 * MB,
        stage: 'downloading',
        secondsLeft: 300,
      }
    );
    assert.equal(
      sabQueueDownload({ ...slot, nzo_id: 'a', status: 'Queued' }, false).stage,
      'queued'
    );
    const paused = sabQueueDownload(
      { ...slot, nzo_id: 'a', status: 'Downloading' },
      true
    );
    assert.deepEqual([paused.stage, paused.secondsLeft], ['paused', undefined]);
  });

  it('names each step after downloading', () => {
    const step = (status: string) => {
      const live = sabHistoryDownload({ nzo_id: 'a', status, bytes: 100 });
      return [live.stage, live.step, live.sizeLeft];
    };
    assert.deepEqual(step('Verifying'), ['finishing', 'verifying', 0]);
    assert.deepEqual(step('QuickCheck'), ['finishing', 'verifying', 0]);
    assert.deepEqual(step('Repairing'), ['finishing', 'repairing', 0]);
    assert.deepEqual(step('Extracting'), ['finishing', 'unpacking', 0]);
    assert.deepEqual(step('Moving'), ['finishing', 'moving', 0]);
    assert.deepEqual(step('Running'), ['finishing', 'script', 0]);
    assert.deepEqual(step('Queued'), ['finishing', undefined, 0]);
    assert.deepEqual(step('Completed'), ['importing', undefined, 0]);
    assert.deepEqual(step('Failed'), ['failed', undefined, 0]);
  });
});

describe('qBittorrent, read directly', () => {
  const torrent = (state: string, extra = {}) =>
    qbitDownload({
      hash: 'a',
      state,
      size: 1000,
      amount_left: 400,
      eta: 120,
      ...extra,
    });

  it('says where a torrent stands, in every state', () => {
    const cases: [string, string, string | undefined][] = [
      ['downloading', 'downloading', undefined],
      ['forcedDL', 'downloading', undefined],
      ['stalledDL', 'stalled', 'noPeers'],
      ['pausedDL', 'paused', undefined],
      ['stoppedDL', 'paused', undefined],
      ['queuedDL', 'queued', undefined],
      ['metaDL', 'queued', 'metadata'],
      ['checkingDL', 'queued', 'checking'],
      ['checkingUP', 'finishing', 'checking'],
      ['moving', 'finishing', 'moving'],
      ['uploading', 'importing', undefined],
      ['stalledUP', 'importing', undefined],
      ['stoppedUP', 'importing', undefined],
      ['error', 'stalled', undefined],
      ['missingFiles', 'needsAttention', undefined],
    ];
    for (const [state, stage, step] of cases) {
      const live = torrent(state);
      assert.deepEqual([live.stage, live.step], [stage, step], state);
    }
  });

  it('gives a time left only when qBittorrent has one', () => {
    assert.equal(torrent('downloading').secondsLeft, 120);
    assert.equal(
      torrent('downloading', { eta: 8_640_000 }).secondsLeft,
      undefined
    );
  });
});

describe('talking to them', () => {
  let sabPort = 0;
  let qbitPort = 0;
  let logins = 0;
  let session = 'first';
  let qbitAnswersByStatus = false;
  const servers: http.Server[] = [];
  /** Ids deleted from SABnzbd. */
  let deleted: string[] = [];
  const queuedJobs = ['SABnzbd_nzo_one'];
  const historyJobs = ['SABnzbd_nzo_two'];
  /** SABnzbd's whole queue, as returned without nzo_ids. */
  let wholeQueue: { kbpersec: string; slots: Record<string, string>[] } = {
    kbpersec: '0',
    slots: [],
  };

  before(async () => {
    const listen = (handler: http.RequestListener) =>
      new Promise<number>((resolve) => {
        const server = http.createServer(handler).listen(0, () => {
          resolve((server.address() as AddressInfo).port);
        });
        servers.push(server);
      });

    sabPort = await listen((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.searchParams.get('mode') === 'version') {
        return res.end(JSON.stringify({ version: '5.1.3' }));
      }
      // SABnzbd answers a wrong key with a normal reply saying so.
      if (url.searchParams.get('apikey') !== 'right') {
        return res.end(
          JSON.stringify({ status: false, error: 'API Key Incorrect' })
        );
      }
      // Like SABnzbd 4.2: status false, no error, for a job not in the
      // queue.
      if (url.searchParams.get('name') === 'delete') {
        const id = url.searchParams.get('value') ?? '';
        const mode = url.searchParams.get('mode');
        deleted.push(`${mode} ${id}`);
        const there =
          mode === 'queue' ? queuedJobs.includes(id) : historyJobs.includes(id);
        return res.end(
          JSON.stringify({ status: there, nzo_ids: there ? [id] : [] })
        );
      }
      const ids = (url.searchParams.get('nzo_ids') ?? '').split(',');
      if (
        url.searchParams.get('mode') === 'queue' &&
        !url.searchParams.has('nzo_ids')
      ) {
        return res.end(JSON.stringify({ queue: wholeQueue }));
      }
      if (url.searchParams.get('mode') === 'queue') {
        return res.end(
          JSON.stringify({
            queue: {
              paused: false,
              slots: ids.includes('SABnzbd_nzo_one')
                ? [
                    {
                      nzo_id: 'SABnzbd_nzo_one',
                      status: 'Downloading',
                      mb: '100',
                      mbleft: '40',
                      timeleft: '0:01:00',
                    },
                  ]
                : [],
            },
          })
        );
      }
      return res.end(
        JSON.stringify({
          history: {
            slots: [
              { nzo_id: 'SABnzbd_nzo_two', status: 'Running', bytes: 5 },
              { nzo_id: UUID_JOB, status: 'Extracting', bytes: 5 },
            ].filter((slot) => ids.includes(slot.nzo_id)),
          },
        })
      );
    });

    qbitPort = await listen((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      if (url.pathname === '/api/v2/auth/login') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          // qBittorrent 5.2+ answers with a status code, not text.
          if (form.get('password') !== 'secret') {
            res.statusCode = qbitAnswersByStatus ? 401 : 200;
            return res.end(qbitAnswersByStatus ? '' : 'Fails.');
          }
          logins++;
          res.setHeader('Set-Cookie', `QBT_SID_8080=${session}; HttpOnly`);
          res.statusCode = qbitAnswersByStatus ? 204 : 200;
          res.end(qbitAnswersByStatus ? '' : 'Ok.');
        });
        return;
      }
      if (req.headers.cookie !== `QBT_SID_8080=${session}`) {
        res.statusCode = 403;
        return res.end('Forbidden');
      }
      if (url.pathname === '/api/v2/app/version') {
        return res.end('v5.0.4');
      }
      res.setHeader('Content-Type', 'application/json');
      const hashes = (url.searchParams.get('hashes') ?? '').split('|');
      // Like a client that ignores the filter: return every torrent.
      if (hashes.includes('b'.repeat(40))) {
        return res.end(
          JSON.stringify(
            ['c', 'b'].map((x) => ({
              hash: x.repeat(40),
              state: 'downloading',
              dlspeed: x === 'b' ? 2000 : 9000,
              size: 10,
              amount_left: 5,
              eta: 5,
            }))
          )
        );
      }
      res.end(
        JSON.stringify(
          hashes.includes('a'.repeat(40))
            ? [
                {
                  hash: 'a'.repeat(40),
                  state: 'stalledDL',
                  size: 10,
                  amount_left: 6,
                  eta: 8_640_000,
                },
              ]
            : []
        )
      );
    });
  });

  after(() => servers.forEach((server) => server.close()));

  const sab = (apiKey: string) =>
    new SabnzbdAPI({
      hostname: '127.0.0.1',
      port: sabPort,
      useSsl: false,
      urlBase: '',
      apiKey,
    });

  it('tests SABnzbd with its key, not just its address', async () => {
    assert.equal(await sab('right').getVersion(), '5.1.3');
    await assert.rejects(sab('wrong').getVersion(), /API Key Incorrect/);
  });

  it("finds SABnzbd's jobs in its queue and history, by either kind of id", async () => {
    const found = await sab('right').getDownloads([
      'SABnzbd_nzo_one',
      'SABnzbd_nzo_two',
      UUID_JOB,
      'A'.repeat(40),
    ]);
    assert.deepEqual([...found.keys()].sort(), [
      UUID_JOB,
      'sabnzbd_nzo_one',
      'sabnzbd_nzo_two',
    ]);
    assert.equal(found.get(UUID_JOB)?.step, 'unpacking', 'current SABnzbd');
    assert.equal(found.get('sabnzbd_nzo_one')?.stage, 'downloading');
    assert.equal(found.get('sabnzbd_nzo_two')?.step, 'script');
  });

  it('deletes a SABnzbd job from its queue, or from its history once it has finished', async () => {
    deleted = [];
    await sab('right').deleteJob('SABnzbd_nzo_one');
    assert.deepEqual(deleted, ['queue SABnzbd_nzo_one']);
    deleted = [];
    await sab('right').deleteJob('SABnzbd_nzo_two');
    assert.deepEqual(deleted, [
      'queue SABnzbd_nzo_two',
      'history SABnzbd_nzo_two',
    ]);
    await assert.rejects(
      sab('right').deleteJob('SABnzbd_nzo_gone'),
      /neither its queue nor its history/
    );
    await assert.rejects(
      sab('wrong').deleteJob('SABnzbd_nzo_one'),
      /API Key Incorrect/
    );
  });

  it('gives a queued SABnzbd job its size in whole bytes', async () => {
    // SABnzbd gives fractional megabytes; Postgres stores whole bytes.
    wholeQueue = {
      kbpersec: '0',
      slots: [
        {
          nzo_id: 'one',
          status: 'Downloading',
          mb: '19510.95',
          mbleft: '2525.67',
          percentage: '87',
          timeleft: '0:05:00',
        },
      ],
    };
    const job = await sab('right').getJob('one');
    assert.equal(job?.size, Math.round(19510.95 * 1024 * 1024));
    assert.equal(job?.sizeLeft, Math.round(2525.67 * 1024 * 1024));
    assert.ok(Number.isInteger(job?.size) && Number.isInteger(job?.sizeLeft));
  });

  it("gives a SABnzbd job the queue's speed only when it is the one downloading", async () => {
    const slot = (nzo_id: string, status: string) => ({
      nzo_id,
      status,
      mb: '1000',
      mbleft: '500',
      percentage: '50',
      timeleft: '0:05:00',
    });
    wholeQueue = {
      kbpersec: '10240',
      slots: [slot('one', 'Downloading'), slot('two', 'Queued')],
    };
    assert.equal((await sab('right').getJob('one'))?.speed, 10240 * 1024);
    assert.equal((await sab('right').getJob('two'))?.speed, 0, 'waiting');
    // Two downloading: the single speed can't be attributed to either.
    wholeQueue = {
      kbpersec: '10240',
      slots: [slot('one', 'Downloading'), slot('two', 'Downloading')],
    };
    const both = await sab('right').getJob('two');
    assert.equal(both?.place, 'queue');
    assert.equal(both?.speed, undefined);
  });

  const qbit = (password: string) =>
    new QBittorrentAPI({
      hostname: '127.0.0.1',
      port: qbitPort,
      useSsl: false,
      urlBase: '',
      username: 'admin',
      password,
    });

  it('signs in to qBittorrent once, and again only when it asks', async () => {
    logins = 0;
    assert.equal(await qbit('secret').getVersion(), 'v5.0.4');
    const found = await qbit('secret').getDownloads(['A'.repeat(40)]);
    assert.equal(found.get('a'.repeat(40))?.stage, 'stalled');
    assert.equal(logins, 1, 'the session is kept between passes');

    session = 'second'; // qBittorrent restarted, dropping the old session
    await qbit('secret').getVersion();
    assert.equal(logins, 2);
  });

  it('reads only the torrent asked for, even from a client ignoring the filter', async () => {
    const torrent = await qbit('secret').getTorrent('B'.repeat(40));
    assert.equal(torrent?.hash, 'b'.repeat(40));
    assert.equal(torrent?.dlspeed, 2000);
  });

  it('signs in to qBittorrent 5.2, which answers with a status', async () => {
    qbitAnswersByStatus = true;
    session = 'five-two';
    try {
      assert.equal(await qbit('secret').getVersion(), 'v5.0.4');
      await assert.rejects(
        new QBittorrentAPI({
          hostname: '127.0.0.1',
          port: qbitPort,
          useSsl: false,
          urlBase: '',
          username: 'someone-else',
          password: 'nope',
        }).getVersion(),
        /did not accept/
      );
    } finally {
      qbitAnswersByStatus = false;
    }
  });

  it('says so when the qBittorrent password is wrong', async () => {
    await assert.rejects(
      new QBittorrentAPI({
        hostname: '127.0.0.1',
        port: qbitPort,
        useSsl: false,
        urlBase: '',
        username: 'someone-else',
        password: 'nope',
      }).getVersion(),
      /did not accept/
    );
  });

  it('tests a wrong qBittorrent password as wrong, though the right one is signed in', async () => {
    assert.equal(await qbit('secret').getVersion(), 'v5.0.4');
    await assert.rejects(qbit('nope').getVersion(), /did not accept/);
  });
});

describe('adding a torrent to qBittorrent for Backfill', () => {
  afterEach(() => mock.restoreAll());

  it('sets no share limits on it, which would have qBittorrent act on it the moment it is done', async () => {
    let form: FormData | undefined;
    mock.method(
      QBittorrentAPI.prototype as unknown as {
        post: (path: string, body: FormData) => Promise<unknown>;
      },
      'post',
      async (_path: string, body: FormData) => {
        form = body;
        return { data: 'Ok.' };
      }
    );
    mock.method(QBittorrentAPI.prototype, 'findTorrent', async () => ({
      hash: 'ab'.repeat(20),
    }));
    await new QBittorrentAPI({
      hostname: '127.0.0.1',
      port: 1,
      useSsl: false,
      urlBase: '',
      username: '',
      password: '',
    }).addTorrent({
      torrent: Buffer.from('torrent'),
      hash: 'ab'.repeat(20),
      category: 'backfill',
    });
    // A limit of 0 is hit at once, and qBittorrent is often set to remove
    // the torrent and files then, before Radarr imports.
    assert.equal(form?.get('ratioLimit'), '-1');
    assert.equal(form?.get('seedingTimeLimit'), '-1');
    assert.equal(form?.get('inactiveSeedingTimeLimit'), '-1');
  });
  const qbit = () =>
    new QBittorrentAPI({
      hostname: '127.0.0.1',
      port: 1,
      useSsl: false,
      urlBase: '',
      username: '',
      password: '',
    });

  it('refuses a torrent qBittorrent does not list under the hash read', async () => {
    mock.method(
      QBittorrentAPI.prototype as unknown as {
        post: (path: string) => Promise<unknown>;
      },
      'post',
      async () => ({ data: 'Ok.' })
    );
    let asked = 0;
    mock.method(QBittorrentAPI.prototype, 'findTorrent', async () => {
      asked++;
      return undefined;
    });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const added = assert.rejects(
        qbit().addTorrent({
          magnet: `magnet:?xt=urn:btih:${'ab'.repeat(20)}`,
          hash: 'ab'.repeat(20),
          category: 'backfill',
        }),
        /did not list the torrent/
      );
      // A busy client gets about 20 seconds to list it.
      for (let second = 0; second < 25; second++) {
        await new Promise((resolve) => setImmediate(resolve));
        mock.timers.tick(1_000);
      }
      await added;
      assert.ok(asked >= 15, String(asked));
    } finally {
      mock.timers.reset();
    }
  });

  it('removes a torrent with its data, unless another torrent shares the files', async () => {
    const own = 'ab'.repeat(20);
    let listed: Record<string, string>[] = [];
    const deletes: unknown[] = [];
    const api = QBittorrentAPI.prototype as unknown as {
      get: (path: string) => Promise<unknown>;
      post: (path: string, body: unknown) => Promise<unknown>;
    };
    mock.method(api, 'get', async () => ({ data: listed }));
    mock.method(api, 'post', async (_path: string, body: unknown) => {
      deletes.push(body);
      return { data: '' };
    });
    const torrent = (hash: string, content: string) => ({
      hash,
      name: content.split('/').pop()!,
      save_path: '/downloads',
      content_path: content,
    });

    listed = [
      torrent(own, '/downloads/Glasswing.S01'),
      torrent('cd'.repeat(20), '/downloads/Glasswing.S02'),
    ];
    await qbit().deleteTorrent(own);
    listed = [
      torrent(own, '/downloads/Glasswing.S01'),
      torrent('cd'.repeat(20), '/downloads/Glasswing.S01'),
    ];
    await qbit().deleteTorrent(own);
    listed = [
      torrent(own, '/downloads/Glasswing.S01'),
      torrent('ef'.repeat(20), '/downloads/Glasswing.S01/Glasswing.S01E01.mkv'),
    ];
    await qbit().deleteTorrent(own);
    // Another torrent added without its own folder (its content is the save
    // folder) doesn't hold every torrent kept there.
    listed = [
      torrent(own, '/downloads/Glasswing.S01'),
      torrent('ef'.repeat(20), '/downloads'),
    ];
    await qbit().deleteTorrent(own);
    assert.deepEqual(deletes, [
      { hashes: own, deleteFiles: 'true' },
      { hashes: own, deleteFiles: 'false' },
      { hashes: own, deleteFiles: 'false' },
      { hashes: own, deleteFiles: 'true' },
    ]);
  });

  it('reads how much of each file the swarm has, unknown as unknown', async () => {
    mock.method(
      QBittorrentAPI.prototype as unknown as {
        get: (path: string) => Promise<unknown>;
      },
      'get',
      async () => ({
        data: [
          {
            index: 0,
            name: 'a.mkv',
            size: 10,
            progress: 0,
            priority: 1,
            availability: 0.98,
          },
          {
            index: 1,
            name: 'b.mkv',
            size: 10,
            progress: 0,
            priority: 1,
            availability: -1,
          },
          {
            index: 2,
            name: 'c.mkv',
            size: 10,
            progress: 0,
            priority: 1,
            availability: 3,
          },
          { name: 'd.mkv', size: 10, progress: 0, priority: 0 },
        ],
      })
    );
    const files = await new QBittorrentAPI({
      hostname: '127.0.0.1',
      port: 1,
      useSsl: false,
      urlBase: '',
      username: '',
      password: '',
    }).getFiles('ABC');
    assert.deepEqual(
      files.map((f) => [f.index, f.availability]),
      [
        [0, 0.98],
        [1, undefined],
        [2, 1],
        [3, undefined],
      ]
    );
  });
});
