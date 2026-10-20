import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_STREAMING_SERVICES,
  leftOutServices,
  readServiceIds,
  readStreamingRow,
  streamingServiceQuery,
  writeStreamingRow,
} from './streamingServices';

/*
 * Streaming services on Discover: the ones a page or row shows only titles
 * on, and the ones it leaves out. Rows made before services could be left
 * out keep working exactly as they did.
 */

describe('streaming service ids', () => {
  it('reads TMDB ids split by | or , each once, in order', () => {
    assert.deepEqual(readServiceIds('8|9|8'), [8, 9]);
    assert.deepEqual(readServiceIds('337,8'), [337, 8]);
    assert.deepEqual(readServiceIds(' 8 | 9 '), [8, 9]);
  });

  it('drops anything that is not an id, rather than failing', () => {
    for (const value of [undefined, null, '', 'undefined', '|', 'abc']) {
      assert.deepEqual(readServiceIds(value), []);
    }
    assert.deepEqual(readServiceIds('8|0|-3|1.5|9e2|x|9'), [8, 9]);
    assert.deepEqual(readServiceIds('12345678901'), []);
  });

  it('keeps no more than the limit', () => {
    const many = Array.from({ length: 150 }, (_, i) => i + 1).join('|');
    assert.equal(readServiceIds(many).length, MAX_STREAMING_SERVICES);
  });

  it('leaves out only services that are not also shown', () => {
    assert.deepEqual(leftOutServices('8|9', '9|337'), [337]);
    assert.deepEqual(leftOutServices(undefined, '337|350'), [337, 350]);
    assert.deepEqual(leftOutServices('8', undefined), []);
  });
});

describe('a streaming services row', () => {
  it('reads a row saved before services could be left out', () => {
    assert.deepEqual(readStreamingRow('US,8|9'), {
      region: 'US',
      on: [8, 9],
      notOn: [],
    });
    assert.deepEqual(readStreamingRow('GB,337'), {
      region: 'GB',
      on: [337],
      notOn: [],
    });
  });

  it('writes an old row back exactly as it was', () => {
    for (const data of ['US,8|9', 'GB,337', 'DE,8|9|337']) {
      assert.equal(writeStreamingRow(readStreamingRow(data)), data);
    }
  });

  it('asks for an old row exactly as before', () => {
    assert.equal(
      streamingServiceQuery(readStreamingRow('US,8|9')),
      'watchRegion=US&watchProviders=8|9'
    );
  });

  it('keeps the services left out after a second comma', () => {
    const row = { region: 'US', on: [8], notOn: [337, 350] };
    assert.equal(writeStreamingRow(row), 'US,8,337|350');
    assert.deepEqual(readStreamingRow('US,8,337|350'), row);
    assert.equal(
      streamingServiceQuery(row),
      'watchRegion=US&watchProviders=8&excludeWatchProviders=337|350'
    );
  });

  it('can leave out services without showing only some', () => {
    const row = readStreamingRow('US,,8');
    assert.deepEqual(row, { region: 'US', on: [], notOn: [8] });
    assert.equal(writeStreamingRow(row), 'US,,8');
    assert.equal(
      streamingServiceQuery(row),
      'watchRegion=US&excludeWatchProviders=8'
    );
  });

  it('copes with a row that has no services or no region', () => {
    assert.deepEqual(readStreamingRow(undefined), { on: [], notOn: [] });
    assert.deepEqual(readStreamingRow('US'), {
      region: 'US',
      on: [],
      notOn: [],
    });
    assert.deepEqual(readStreamingRow('nowhere,8'), { on: [8], notOn: [] });
    assert.equal(streamingServiceQuery(readStreamingRow('US')), '');
    assert.equal(
      streamingServiceQuery(readStreamingRow('us,8')),
      'watchRegion=US&watchProviders=8'
    );
  });

  it('never leaves out a service it shows', () => {
    assert.deepEqual(readStreamingRow('US,8|9,9|337'), {
      region: 'US',
      on: [8, 9],
      notOn: [337],
    });
    assert.equal(
      writeStreamingRow({ region: 'US', on: [8], notOn: [8, 337] }),
      'US,8,337'
    );
  });
});
