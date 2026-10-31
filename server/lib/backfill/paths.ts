import { baseName } from '@server/lib/backfill/naming';

/*
 * Where a download's files are: each chosen file in the client's own list,
 * and a path the client gave as Sonarr, Radarr or Lidarr sees it.
 */

/** A path inside a torrent without its top folder, which clients may rename. */
const insidePath = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
};

/**
 * Where each chosen file is in the client's own list, in the order given;
 * undefined for one that is not there.
 *
 * Backfill numbers a .torrent's files leaving out its padding files (BEP
 * 47), as qBittorrent does. rTorrent, Transmission before 4, and Deluge on
 * some versions list them, which moves every file after one along. So a
 * file numbered the same in the client is taken when it is the same file;
 * otherwise it is looked for by its path inside the torrent and its size,
 * and last by its name and size.
 */
export const placeFiles = (
  chosen: { index: number; path: string; size: number }[],
  files: { index: number; name: string; size: number }[]
): (number | undefined)[] =>
  chosen.map((file) => {
    const inside = insidePath(file.path);
    const same = files.find((f) => f.index === file.index);
    if (same && insidePath(same.name) === inside) return same.index;
    const byPath = files.filter(
      (f) => insidePath(f.name) === inside && f.size === file.size
    );
    if (byPath.length === 1) return byPath[0].index;
    const name = baseName(file.path.replace(/\\/g, '/'));
    if (same && baseName(same.name.replace(/\\/g, '/')) === name) {
      return same.index;
    }
    const byName = files.filter(
      (f) =>
        baseName(f.name.replace(/\\/g, '/')) === name && f.size === file.size
    );
    return byName.length === 1 ? byName[0].index : undefined;
  });

/**
 * A path the download client gave, as Sonarr or Radarr sees it, by the
 * remote path mapping that fits it best. What follows the mapped folder is
 * written with the app's own separators: a Windows client's
 * "D:\dl\Show\ep.mkv" mapped to "/data/" is "/data/Show/ep.mkv".
 */
export const mapRemotePath = (
  path: string,
  host: string,
  mappings: { host: string; remotePath: string; localPath: string }[]
): string => {
  const windows = /^[a-z]:\\|^\\\\/i.test(path);
  const norm = (p: string) =>
    windows ? p.replace(/\//g, '\\').toLowerCase() : p;
  const mapping = mappings
    .filter(
      (m) =>
        m.host.toLowerCase() === host.toLowerCase() &&
        norm(path).startsWith(norm(m.remotePath))
    )
    .sort((a, b) => b.remotePath.length - a.remotePath.length)[0];
  if (!mapping) return path;
  const local = mapping.localPath;
  // A backslash is a separator only in a Windows path; elsewhere it can be
  // part of a file's name.
  const theirs = windows ? /[\\/]+/g : /\/+/g;
  const rest = path.slice(mapping.remotePath.length).replace(/^[\\/]+/, '');
  if (!rest) return local;
  const sep = /^[a-z]:[\\/]|^\\\\/i.test(local) ? '\\' : '/';
  return `${local.replace(/[\\/]+$/, '')}${sep}${rest.replace(theirs, sep)}`;
};
