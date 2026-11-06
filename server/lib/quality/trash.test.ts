import {
  readTrashState,
  refreshTrash,
  refreshTrashIfOlder,
  trashData,
  trashHttp,
} from '@server/lib/quality/trash';
import { getSettings } from '@server/lib/settings';
import * as appData from '@server/utils/appDataVolume';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

/*
 * Keeping TRaSH Guides current: GitHub requests, no refetch on a 304, and
 * no overlapping checks.
 */

const CF = 'docs/json/radarr/cf/made-up-format.json';
const FILES: Record<string, unknown> = {
  'metadata.json': {
    json_paths: {
      radarr: { custom_formats: ['docs/json/radarr/cf'] },
      sonarr: { custom_formats: ['docs/json/sonarr/cf'] },
    },
  },
  [CF]: {
    trash_id: 'aaaa0000',
    name: 'Made-up format',
    specifications: [],
  },
};

let dir: string;
let commit: string;
let calls: { url: string; headers: Record<string, string> }[];
let history = 'ahead';

const answer = (url: string, headers: Record<string, string>) => {
  calls.push({ url, headers });
  if (url.endsWith('/commits/master')) {
    const etag = `"${commit}"`;
    return headers['If-None-Match'] === etag
      ? { status: 304, data: '', headers: { etag } }
      : { status: 200, data: { sha: commit }, headers: { etag } };
  }
  if (url.includes('/compare/')) {
    return { status: 200, data: { status: history }, headers: {} };
  }
  if (url.includes('/git/trees/')) {
    return {
      status: 200,
      data: {
        tree: Object.keys(FILES).map((file) => ({
          path: file,
          type: 'blob',
          sha: `${file}@${commit}`,
        })),
      },
      headers: {},
    };
  }
  const file = Object.keys(FILES).find((f) => url.endsWith(`/${f}`));
  if (!file) throw new Error(`not expected: ${url}`);
  return { status: 200, data: FILES[file], headers: {} };
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-trash-'));
  mock.method(appData, 'appDataPath', () => dir);
  mock.method(
    trashHttp,
    'get',
    async (url: string, config?: { headers?: Record<string, string> }) =>
      answer(url, config?.headers ?? {})
  );
});

after(() => {
  mock.restoreAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
});

describe('TRaSH Guides', () => {
  it('fetches it the first time, keeping GitHub’s tag', async () => {
    commit = 'c1';
    const state = await refreshTrash();
    assert.equal(state.commit, 'c1');
    assert.equal(state.etag, '"c1"');
    assert.equal(state.error, undefined);
    assert.equal(
      (await trashData())?.radarr.formats.aaaa0000?.name,
      'Made-up format'
    );
    assert.equal(calls[0].headers['If-None-Match'], undefined);
  });

  it('asks with the tag, and fetches nothing when GitHub says unchanged', async () => {
    const before = (await readTrashState()).checkedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const state = await refreshTrash();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['If-None-Match'], '"c1"');
    assert.equal(state.commit, 'c1');
    assert.notEqual(state.checkedAt, before);
  });

  it('fetches a new commit’s files', async () => {
    commit = 'c2';
    const state = await refreshTrash();
    assert.equal(state.commit, 'c2');
    assert.equal(state.etag, '"c2"');
    assert.ok(calls.some((c) => c.url.includes('/git/trees/c2')));
    assert.equal((await trashData())?.commit, 'c2');
  });

  it('runs one check at a time', async () => {
    const [a, b] = await Promise.all([refreshTrash(), refreshTrash()]);
    assert.equal(a, b);
    assert.equal(
      calls.filter((c) => c.url.endsWith('/commits/master')).length,
      1
    );
  });

  it('skips a check made moments ago', async () => {
    await refreshTrashIfOlder(60_000);
    assert.equal(calls.length, 0);
    await refreshTrashIfOlder(0);
    assert.equal(calls.length, 1);
  });

  it('keeps GitHub’s answers within a size limit', () => {
    assert.ok(Number(trashHttp.defaults.maxContentLength) > 0);
  });

  it('takes only a commit that follows on from its copy while updates apply on their own', async () => {
    const settings = getSettings();
    const saved = settings.quality;
    settings.quality = { ...saved, trash: { ...saved.trash, autoApply: true } };
    try {
      commit = 'c3';
      history = 'diverged';
      let state = await refreshTrash();
      assert.equal(state.commit, 'c2');
      assert.match(state.error ?? '', /does not follow on from c2/);
      assert.ok(calls.some((c) => c.url.endsWith('/compare/c2...c3')));
      assert.equal((await trashData())?.commit, 'c2');

      history = 'ahead';
      state = await refreshTrash();
      assert.equal(state.commit, 'c3');
      assert.equal(state.error, undefined);
    } finally {
      settings.quality = saved;
      history = 'ahead';
    }
  });

  it('takes any newer commit while updates wait for an admin', async () => {
    commit = 'c4';
    history = 'diverged';
    try {
      assert.equal((await refreshTrash()).commit, 'c4');
      assert.ok(!calls.some((c) => c.url.includes('/compare/')));
    } finally {
      history = 'ahead';
    }
  });

  it('keeps the copy it has when GitHub fails', async () => {
    mock.method(trashHttp, 'get', async () => {
      throw new Error('Request failed with status code 403');
    });
    const state = await refreshTrash();
    assert.equal(state.commit, 'c4');
    assert.match(state.error ?? '', /403/);
    assert.equal((await trashData())?.commit, 'c4');
  });
});
