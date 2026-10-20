import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chooseService,
  countActiveFilters,
  nextServiceChoice,
  prepareFilterValues,
  serviceChoiceOf,
  serviceFilters,
  servicesOf,
} from './filters';

describe('prepareFilterValues', () => {
  it('keeps the filters in the address and drops the rest', () => {
    assert.deepEqual(
      prepareFilterValues({
        genre: '18',
        voteAverageGte: '7',
        page: '2',
        certification: '',
      }),
      { genre: '18', voteAverageGte: '7' }
    );
  });

  it('uses the first of a filter given twice, rather than failing', () => {
    assert.deepEqual(prepareFilterValues({ genre: ['18', '35'] }), {
      genre: '18',
    });
  });

  it('works out how certifications are matched', () => {
    assert.equal(
      prepareFilterValues({ certification: 'PG' }).certificationMode,
      'exact'
    );
    assert.equal(
      prepareFilterValues({ certificationGte: 'PG' }).certificationMode,
      'range'
    );
    assert.equal(
      prepareFilterValues({ certificationMode: 'sideways' }).certificationMode,
      undefined
    );
  });

  it('counts a range as one filter', () => {
    assert.equal(
      countActiveFilters(
        prepareFilterValues({
          voteAverageGte: '6',
          voteAverageLte: '9',
          genre: '18',
        })
      ),
      2
    );
  });
});

describe('streaming services in Filters', () => {
  it('reads the services left out from the address', () => {
    assert.deepEqual(
      prepareFilterValues({
        watchRegion: 'US',
        watchProviders: '8',
        excludeWatchProviders: '337|350',
      }),
      {
        watchRegion: 'US',
        watchProviders: '8',
        excludeWatchProviders: '337|350',
      }
    );
  });

  it('drops what is not a service, or one also shown, from the address', () => {
    assert.deepEqual(
      prepareFilterValues({
        watchRegion: 'US',
        watchProviders: '8',
        excludeWatchProviders: '8|x|337',
      }),
      { watchRegion: 'US', watchProviders: '8', excludeWatchProviders: '337' }
    );
    assert.deepEqual(
      prepareFilterValues({ watchRegion: 'US', excludeWatchProviders: 'x' }),
      { watchRegion: 'US' }
    );
  });

  it('counts services shown and services left out as a filter each', () => {
    assert.equal(
      countActiveFilters(
        prepareFilterValues({ watchRegion: 'US', watchProviders: '8|9' })
      ),
      1
    );
    assert.equal(
      countActiveFilters(
        prepareFilterValues({
          watchRegion: 'US',
          excludeWatchProviders: '337',
        })
      ),
      1
    );
    assert.equal(
      countActiveFilters(
        prepareFilterValues({
          watchRegion: 'US',
          watchProviders: '8',
          excludeWatchProviders: '337',
          genre: '18',
        })
      ),
      3
    );
  });

  it('goes from shown only, to left out, to neither', () => {
    assert.equal(nextServiceChoice(undefined), 'on');
    assert.equal(nextServiceChoice('on'), 'notOn');
    assert.equal(nextServiceChoice('notOn'), undefined);
  });

  it('moves a service between the lists', () => {
    let services = { on: [8], notOn: [] as number[] };
    assert.equal(serviceChoiceOf(services, 8), 'on');
    assert.equal(serviceChoiceOf(services, 9), undefined);
    services = chooseService(services, 8, 'notOn');
    assert.deepEqual(services, { on: [], notOn: [8] });
    assert.equal(serviceChoiceOf(services, 8), 'notOn');
    services = chooseService(services, 9, 'on');
    assert.deepEqual(services, { on: [9], notOn: [8] });
    services = chooseService(services, 8, undefined);
    assert.deepEqual(services, { on: [9], notOn: [] });
  });

  it('puts the services back in the address, and takes them all out', () => {
    assert.deepEqual(serviceFilters('US', { on: [8, 9], notOn: [337] }), {
      watchRegion: 'US',
      watchProviders: '8|9',
      excludeWatchProviders: '337',
    });
    assert.deepEqual(serviceFilters('US', { on: [], notOn: [337] }), {
      watchRegion: 'US',
      watchProviders: undefined,
      excludeWatchProviders: '337',
    });
    assert.deepEqual(serviceFilters('US', { on: [], notOn: [] }), {
      watchRegion: undefined,
      watchProviders: undefined,
      excludeWatchProviders: undefined,
    });
  });

  it('round-trips through the address', () => {
    const address = serviceFilters('GB', { on: [8], notOn: [337, 350] });
    const read = prepareFilterValues(address);
    assert.deepEqual(read, address);
    assert.deepEqual(servicesOf(read), { on: [8], notOn: [337, 350] });
    assert.deepEqual(serviceFilters('GB', servicesOf(read)), address);
  });
});
