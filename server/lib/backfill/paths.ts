import { baseName } from '@server/lib/backfill/naming';

/*
 * Locates a download's files: each chosen file in the client's list, and a
 * client path as Sonarr, Radarr or Lidarr sees it.
 */

/**
 * Whether a torrent's file name escapes its folder: a `..` part, or a root
 * or drive path.
 */
export const escapesFolder = (name: string): boolean =>
  /^([\\/]|[A-Za-z]:)/.test(name) || name.split(/[\\/]/).includes('..');

/** A torrent path without its top folder, which clients may rename. */
const insidePath = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
};

/**
 * Each chosen file's index in the client's list, in order; undefined if
 * missing.
 *
 * Backfill numbers files without BEP 47 padding, as qBittorrent does.
 * rTorrent, Transmission before 4 and some Deluge versions count padding,
 * shifting later files. So the same index is taken only for the same file;
 * otherwise match by inside path and size, then by name and size.
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
 * A client path as Sonarr or Radarr sees it, via the longest matching remote
 * path mapping. The rest uses the app's separators: a Windows client's
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
  // Backslash separates only in Windows paths; elsewhere it can be in a name.
  const theirs = windows ? /[\\/]+/g : /\/+/g;
  const rest = path.slice(mapping.remotePath.length).replace(/^[\\/]+/, '');
  if (!rest) return local;
  const sep = /^[a-z]:[\\/]|^\\\\/i.test(local) ? '\\' : '/';
  return `${local.replace(/[\\/]+$/, '')}${sep}${rest.replace(theirs, sep)}`;
};
