import type { MediaServerKind } from '@server/constants/server';
import type { PlayLink } from '@server/entity/Media';
import { accountServers, SERVER_NAMES } from './mediaServerAccounts';

/*
 * Where a title can be played. The server sends a link for each connected
 * media server that has the title, the primary server's first. Pages that
 * show every link put the viewer's own servers first; badges, request cards
 * and issues show one: on a server the viewer has an account on, else the
 * first that has the title.
 */

export type { PlayLink };

/** One place to play one version of a title. */
export interface PlayTarget {
  server: MediaServerKind;
  /** The server's kind, as people know it: Plex, Jellyfin, Emby. */
  name: string;
  url: string;
}

interface Viewer {
  userType: number;
  linkedServers?: MediaServerKind[];
}

/** What a title's media info says about where to play it. */
export interface MediaPlayInfo {
  playLinks?: PlayLink[];
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
}

/**
 * A title's play links. An answer from before titles had one for each
 * server (kept by the service worker, say) only has the primary server's,
 * as mediaUrl.
 */
export const playLinksOf = (
  media: MediaPlayInfo | undefined,
  mediaServers: { kind: MediaServerKind; primary: boolean }[]
): PlayLink[] => {
  if (!media) {
    return [];
  }
  if (media.playLinks) {
    return media.playLinks;
  }
  const primary = (
    mediaServers.find((server) => server.primary) ?? mediaServers[0]
  )?.kind;
  if (!primary || (!media.mediaUrl && !media.mediaUrl4k)) {
    return [];
  }
  return [
    {
      server: primary,
      name: SERVER_NAMES[primary],
      url: media.mediaUrl,
      url4k: media.mediaUrl4k,
      iosUrl: media.iOSPlexUrl,
      iosUrl4k: media.iOSPlexUrl4k,
    },
  ];
};

/** On an iPhone or iPad, a Plex link opens Plex's app rather than the web. */
export const withAppLinks = (link: PlayLink): PlayLink =>
  link.server === 'plex'
    ? { ...link, url: link.iosUrl, url4k: link.iosUrl4k }
    : link;

/** An iPhone or iPad, including an iPad that says it is a Mac. */
export const isAppleTouchDevice = ({
  userAgent,
  maxTouchPoints,
}: {
  userAgent: string;
  maxTouchPoints: number;
}): boolean =>
  /iPad|iPhone|iPod/.test(userAgent) ||
  (userAgent.includes('Mac') && maxTouchPoints > 1);

/**
 * The links with those on servers the viewer has an account on first,
 * otherwise in the order the server gave (the primary server first).
 */
export const orderPlayLinks = (
  links: PlayLink[],
  viewer: Viewer | undefined
): PlayLink[] => {
  const own = viewer ? accountServers(viewer) : [];
  return [
    ...links.filter((link) => own.includes(link.server)),
    ...links.filter((link) => !own.includes(link.server)),
  ];
};

/**
 * The one link to offer for a title, or its 4K version: on a server the
 * viewer has an account on (the primary one first), else on the first
 * server that has it.
 */
export const pickPlayLink = (
  links: PlayLink[],
  viewer: Viewer | undefined,
  is4k = false
): PlayTarget | undefined => {
  for (const link of orderPlayLinks(links, viewer)) {
    const url = is4k ? link.url4k : link.url;
    if (url) {
      return { server: link.server, name: link.name, url };
    }
  }
  return undefined;
};

/**
 * The server the viewer watches on: the first connected one (primary
 * first) they have an account on, else the primary one.
 */
export const viewerServer = (
  viewer: Viewer | undefined,
  mediaServers: { kind: MediaServerKind }[]
): MediaServerKind | undefined => {
  const own = viewer ? accountServers(viewer) : [];
  return (
    mediaServers.find((server) => own.includes(server.kind)) ?? mediaServers[0]
  )?.kind;
};
