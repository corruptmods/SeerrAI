import { UserType } from '@server/constants/user';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountServers,
  connectedAccountServers,
  mainServerOf,
  signInServers,
} from './mediaServerAccounts';

describe('someone’s media server accounts', () => {
  it('lists their main account first', () => {
    assert.deepEqual(
      accountServers({
        userType: UserType.EMBY,
        linkedServers: ['plex', 'jellyfin', 'emby'],
      }),
      ['emby', 'plex', 'jellyfin']
    );
    assert.deepEqual(
      accountServers({ userType: UserType.LOCAL, linkedServers: ['plex'] }),
      ['plex']
    );
    assert.equal(mainServerOf({ userType: UserType.LOCAL }), undefined);
  });

  it('reads an answer from before people could have several', () => {
    assert.deepEqual(accountServers({ userType: UserType.JELLYFIN }), [
      'jellyfin',
    ]);
    assert.deepEqual(accountServers({ userType: UserType.LOCAL }), []);
  });

  it('keeps those on servers Seerr is connected to', () => {
    assert.deepEqual(
      connectedAccountServers(
        { userType: UserType.PLEX, linkedServers: ['plex', 'emby'] },
        [{ kind: 'emby' }, { kind: 'jellyfin' }]
      ),
      ['emby']
    );
  });
});

describe('the servers people may sign in with', () => {
  const mediaServers = [
    { kind: 'jellyfin' as const, signIn: true },
    { kind: 'plex' as const, signIn: false },
    { kind: 'emby' as const, signIn: true },
  ];

  it('are those whose sign-in is on, the primary one first', () => {
    assert.deepEqual(signInServers({ mediaServerLogin: true, mediaServers }), [
      'jellyfin',
      'emby',
    ]);
  });

  it('are none with media server sign-in turned off', () => {
    assert.deepEqual(
      signInServers({ mediaServerLogin: false, mediaServers }),
      []
    );
  });
});
