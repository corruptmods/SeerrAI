import { UserType } from '@server/constants/user';
import type { PlayLink } from '@server/entity/Media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAppleTouchDevice,
  orderPlayLinks,
  pickPlayLink,
  playLinksOf,
  viewerServer,
  withAppLinks,
} from './playLinks';

const plex: PlayLink = {
  server: 'plex',
  name: 'Plex',
  url: 'https://app.plex.tv/plex-1',
  iosUrl: 'plex://plex-1',
};
const jellyfin: PlayLink = {
  server: 'jellyfin',
  name: 'Jellyfin',
  url: 'https://jellyfin/jf-1',
  url4k: 'https://jellyfin/jf-4k',
};
const emby: PlayLink = {
  server: 'emby',
  name: 'Emby',
  url4k: 'https://emby/emby-4k',
};

// As the server sends them: the primary server's first.
const links = [plex, jellyfin, emby];

const mediaServers = [
  { kind: 'plex' as const, primary: true },
  { kind: 'jellyfin' as const, primary: false },
  { kind: 'emby' as const, primary: false },
];

describe('the play link a badge or card offers', () => {
  it('is on a server the viewer has an account on', () => {
    assert.deepEqual(
      pickPlayLink(links, {
        userType: UserType.JELLYFIN,
        linkedServers: ['jellyfin'],
      }),
      { server: 'jellyfin', name: 'Jellyfin', url: 'https://jellyfin/jf-1' }
    );
  });

  it('is on the primary server of those the viewer has accounts on', () => {
    assert.equal(
      pickPlayLink(links, {
        userType: UserType.JELLYFIN,
        linkedServers: ['plex', 'jellyfin'],
      })?.server,
      'plex'
    );
  });

  it('is on the primary server for someone with no account on any', () => {
    assert.equal(
      pickPlayLink(links, { userType: UserType.LOCAL, linkedServers: [] })
        ?.server,
      'plex'
    );
    assert.equal(pickPlayLink(links, undefined)?.server, 'plex');
  });

  it('is on another server when the viewer’s own does not have it', () => {
    assert.equal(
      pickPlayLink([jellyfin], {
        userType: UserType.PLEX,
        linkedServers: ['plex'],
      })?.server,
      'jellyfin'
    );
  });

  it('for 4K, is on a server that has it in 4K', () => {
    assert.deepEqual(
      pickPlayLink(
        links,
        { userType: UserType.PLEX, linkedServers: ['plex', 'emby'] },
        true
      ),
      { server: 'emby', name: 'Emby', url: 'https://emby/emby-4k' }
    );
    assert.equal(
      pickPlayLink(
        links,
        { userType: UserType.PLEX, linkedServers: ['plex'] },
        true
      )?.server,
      'jellyfin'
    );
  });

  it('is none when no server has it', () => {
    assert.equal(pickPlayLink([], undefined), undefined);
    assert.equal(pickPlayLink([plex], undefined, true), undefined);
  });

  it('reads an answer from before people could have several accounts', () => {
    assert.equal(
      pickPlayLink(links, { userType: UserType.JELLYFIN })?.server,
      'jellyfin'
    );
  });
});

describe('the play links a title page offers', () => {
  it('puts the viewer’s own servers first, then the rest in order', () => {
    assert.deepEqual(
      orderPlayLinks(links, {
        userType: UserType.EMBY,
        linkedServers: ['emby'],
      }).map((link) => link.server),
      ['emby', 'plex', 'jellyfin']
    );
    assert.deepEqual(
      orderPlayLinks(links, undefined).map((link) => link.server),
      ['plex', 'jellyfin', 'emby']
    );
  });
});

describe('a title’s play links', () => {
  it('are the ones the server sent', () => {
    assert.deepEqual(playLinksOf({ playLinks: links }, mediaServers), links);
    assert.deepEqual(playLinksOf(undefined, mediaServers), []);
  });

  it('come from the single link in an answer from before', () => {
    assert.deepEqual(
      playLinksOf(
        {
          mediaUrl: 'https://jellyfin/jf-1',
          mediaUrl4k: 'https://jellyfin/jf-4k',
        },
        [{ kind: 'jellyfin', primary: true }]
      ),
      [
        {
          server: 'jellyfin',
          name: 'Jellyfin',
          url: 'https://jellyfin/jf-1',
          url4k: 'https://jellyfin/jf-4k',
          iosUrl: undefined,
          iosUrl4k: undefined,
        },
      ]
    );
    assert.deepEqual(playLinksOf({}, mediaServers), []);
  });
});

describe('play links on an iPhone or iPad', () => {
  it('open Plex’s app', () => {
    assert.deepEqual(withAppLinks(plex), {
      ...plex,
      url: 'plex://plex-1',
      url4k: undefined,
    });
  });

  it('leave Jellyfin and Emby as they are', () => {
    assert.equal(withAppLinks(jellyfin), jellyfin);
  });

  it('are used on iPhones, iPads and iPads that say they are Macs', () => {
    assert.equal(
      isAppleTouchDevice({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        maxTouchPoints: 5,
      }),
      true
    );
    assert.equal(
      isAppleTouchDevice({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 5,
      }),
      true
    );
    assert.equal(
      isAppleTouchDevice({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 0,
      }),
      false
    );
  });
});

describe('the server a viewer watches on', () => {
  it('is the first connected one they have an account on', () => {
    assert.equal(
      viewerServer(
        { userType: UserType.EMBY, linkedServers: ['emby', 'jellyfin'] },
        mediaServers
      ),
      'jellyfin'
    );
  });

  it('is the primary one for anyone else', () => {
    assert.equal(
      viewerServer({ userType: UserType.LOCAL, linkedServers: [] }, [
        { kind: 'emby' },
        { kind: 'plex' },
      ]),
      'emby'
    );
    assert.equal(viewerServer(undefined, []), undefined);
  });
});
