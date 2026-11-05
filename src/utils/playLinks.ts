import type { MediaServerKind } from '@server/constants/server';
import type { PlayLink } from '@server/entity/Media';
import { accountServers, SERVER_NAMES } from './mediaServerAccounts';

/*
 * Play links. The server sends one per connected media server with the
 * title, primary first. Full lists put the viewer's servers first; badges,
 * request cards and issues show one: the viewer's server, else the first.
 */

export type { PlayLink };

/** Where to play one version of a title. */
export interface PlayTarget {
  server: MediaServerKind;
  /** Server kind: Plex, Jellyfin, Emby. */
  name: string;
  url: string;
}

interface Viewer {
  userType: number;
  linkedServers?: MediaServerKind[];
}

/** The play-related fields of a title's media info. */
export interface MediaPlayInfo {
  playLinks?: PlayLink[];
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
}

/**
 * A title's play links. Older cached responses only have the primary
 * server's, as mediaUrl.
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

/** On iPhone/iPad, Plex links open the Plex app instead of the web. */
export const withAppLinks = (link: PlayLink): PlayLink =>
  link.server === 'plex'
    ? { ...link, url: link.iosUrl, url4k: link.iosUrl4k }
    : link;

/** iPhone or iPad, including iPads reporting as Mac. */
export const isAppleTouchDevice = ({
  userAgent,
  maxTouchPoints,
}: {
  userAgent: string;
  maxTouchPoints: number;
}): boolean =>
  /iPad|iPhone|iPod/.test(userAgent) ||
  (userAgent.includes('Mac') && maxTouchPoints > 1);

/** Links on the viewer's servers first, otherwise in server order (primary first). */
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
 * The single link for a title (or its 4K version): the viewer's server
 * (primary first), else the first server with it.
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

/** The viewer's server: the first (primary first) they have an account on, else the primary. */
export const viewerServer = (
  viewer: Viewer | undefined,
  mediaServers: { kind: MediaServerKind }[]
): MediaServerKind | undefined => {
  const own = viewer ? accountServers(viewer) : [];
  return (
    mediaServers.find((server) => own.includes(server.kind)) ?? mediaServers[0]
  )?.kind;
};
