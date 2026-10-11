import { createHash } from 'node:crypto';

/*
 * Just enough of BitTorrent's bencoding to read a .torrent file: its files,
 * their sizes, and its info hash (the SHA-1 of the raw "info" dictionary),
 * which is the torrent's id in qBittorrent.
 */

export interface TorrentFile {
  /** Position in the torrent, which is qBittorrent's file index. */
  index: number;
  /** Path inside the torrent, with "/" between parts. */
  path: string;
  size: number;
}

export interface TorrentMeta {
  infoHash: string;
  name: string;
  files: TorrentFile[];
}

type Value = number | Buffer | Value[] | { [key: string]: Value };

class Reader {
  public pos = 0;
  public infoStart = -1;
  public infoEnd = -1;
  private depth = 0;

  constructor(private data: Buffer) {}

  read(): Value {
    if (this.pos >= this.data.length) {
      throw new Error('The torrent file ends early.');
    }
    const c = this.data[this.pos];
    if (c === 0x69 /* i */) {
      const end = this.data.indexOf(0x65 /* e */, this.pos);
      if (end < 0) throw new Error('Bad number in the torrent file.');
      const n = Number(this.data.subarray(this.pos + 1, end).toString('ascii'));
      this.pos = end + 1;
      return n;
    }
    if (c === 0x6c /* l */) {
      this.pos++;
      this.enter();
      const list: Value[] = [];
      while (this.data[this.pos] !== 0x65) list.push(this.read());
      this.pos++;
      this.depth--;
      return list;
    }
    if (c === 0x64 /* d */) {
      this.pos++;
      this.enter();
      const dict: { [key: string]: Value } = {};
      while (this.data[this.pos] !== 0x65) {
        const key = (this.read() as Buffer).toString('utf8');
        const start = this.pos;
        dict[key] = this.read();
        if (key === 'info' && this.depth === 1 && this.infoStart < 0) {
          this.infoStart = start;
          this.infoEnd = this.pos;
        }
      }
      this.pos++;
      this.depth--;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = this.data.indexOf(0x3a /* : */, this.pos);
      if (colon < 0) throw new Error('Bad string in the torrent file.');
      const len = Number(this.data.subarray(this.pos, colon).toString('ascii'));
      const start = colon + 1;
      if (!Number.isFinite(len) || start + len > this.data.length) {
        throw new Error('The torrent file ends early.');
      }
      this.pos = start + len;
      return this.data.subarray(start, start + len);
    }
    throw new Error('This is not a torrent file.');
  }

  private enter() {
    if (++this.depth > 64) throw new Error('The torrent file nests too deep.');
  }
}

const text = (value: Value | undefined): string =>
  Buffer.isBuffer(value) ? value.toString('utf8') : '';

export const parseTorrent = (data: Buffer): TorrentMeta => {
  const reader = new Reader(data);
  const root = reader.read();
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('This is not a torrent file.');
  }
  const info = (root as Record<string, Value>).info as Record<string, Value>;
  if (!info || reader.infoStart < 0) {
    throw new Error('The torrent file has no info section.');
  }
  const infoHash = createHash('sha1')
    .update(data.subarray(reader.infoStart, reader.infoEnd))
    .digest('hex');
  const name = text(info['name.utf-8']) || text(info.name);
  const files: TorrentFile[] = [];
  if (Array.isArray(info.files)) {
    for (const entry of info.files) {
      const file = entry as Record<string, Value>;
      const parts = (
        (Array.isArray(file['path.utf-8'])
          ? file['path.utf-8']
          : file.path) as Value[]
      ).map(text);
      // Padding (BEP 47) is no file to qBittorrent, which leaves it out of
      // its numbering.
      if (text(file.attr).includes('p') || parts[0] === '.pad') continue;
      files.push({
        index: files.length,
        // qBittorrent names files with the torrent's folder in front.
        path: [name, ...parts].join('/'),
        size: Number(file.length) || 0,
      });
    }
  } else if (typeof info.length === 'number') {
    files.push({ index: 0, path: name, size: info.length });
  } else {
    throw new Error('Only version 1 torrents can be read.');
  }
  return { infoHash, name, files };
};

/** The info hash in a magnet link, as 40 hex characters. */
export const magnetHash = (uri: string): string | undefined => {
  const match = uri.match(/xt=urn:btih:([0-9a-z]+)/i);
  if (!match) return undefined;
  const id = match[1];
  if (/^[0-9a-f]{40}$/i.test(id)) return id.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(id)) return base32ToHex(id);
  return undefined;
};

const base32ToHex = (input: string): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.slice(0, 40);
};
