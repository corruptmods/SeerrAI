/*
 * Titles a scan skipped because the media server has not identified them
 * yet. A server that has just found new files lists them before it has
 * looked them up, so for a while they have no TMDB, TVDB or IMDb id and
 * nothing to match them by. That is normal, not a failure: each is noted
 * at debug level, and the scan ends with one line saying how many there
 * were and what to do about them.
 */

/** Whether a skipped title is a film or a series. */
export type TitleKind = 'film' | 'series';

/** A title as the log names it: never the server's whole record. */
export interface ItemLabel {
  name: string;
  year?: number;
  /** The server's own word for it: Movie, Series, show, episode… */
  type: string;
  id: string;
}

/** "Name (2021)", or just the name when the server has no year. */
export const nameOf = (item: ItemLabel): string =>
  item.year ? `${item.name} (${item.year})` : item.name;

/**
 * A title with no id to match it by. The message is what the scan always
 * said, so anything keeping it (Plex's list of titles to try again) is
 * unchanged.
 */
export class NotIdentifiedError extends Error {
  constructor(
    public readonly kind: TitleKind,
    public readonly item: ItemLabel,
    message = 'Unable to find TMDB ID'
  ) {
    super(message);
    this.name = 'NotIdentifiedError';
  }
}

/** How many names the summary line carries. */
const EXAMPLES = 5;

interface Wording {
  /** Plex, Jellyfin or Emby. */
  server: string;
  /** What the server calls it: Plex matches, Jellyfin and Emby identify. */
  verb: 'matched' | 'identified';
  /** Where in the server to hurry it along. */
  hint: string;
}

const counted = (count: number, kind: TitleKind): string =>
  kind === 'series'
    ? `${count} series`
    : `${count} ${count === 1 ? 'film' : 'films'}`;

/**
 * The line a scan ends with, e.g. "Emby: 38 films and 4 series aren't
 * identified by Emby yet, so they were skipped. …"
 */
export const unidentifiedSummary = ({
  server,
  verb,
  hint,
  films,
  series,
}: Wording & { films: number; series: number }): string => {
  const parts = [
    ...(films ? [counted(films, 'film')] : []),
    ...(series ? [counted(series, 'series')] : []),
  ];
  const one = films + series === 1;
  return (
    `${server}: ${parts.join(' and ')} ${one ? "isn't" : "aren't"} ` +
    `${verb} by ${server} yet, so ${one ? 'it was' : 'they were'} skipped. ` +
    `${one ? "It'll" : "They'll"} be picked up once ${server} has ${verb} ` +
    `${one ? 'it' : 'them'} (in ${server}: ${hint}).`
  );
};

/** The titles one scan skipped as not identified yet. */
export class UnidentifiedTitles {
  private films = 0;
  private series = 0;
  private names: string[] = [];

  constructor(private readonly wording: Wording) {}

  /** Starts afresh, for a new scan. */
  public clear(): void {
    this.films = 0;
    this.series = 0;
    this.names = [];
  }

  /** Counts a skipped title; answers the debug line to log for it. */
  public add(kind: TitleKind, item: ItemLabel): string {
    if (kind === 'film') {
      this.films += 1;
    } else {
      this.series += 1;
    }
    if (this.names.length < EXAMPLES) {
      this.names.push(nameOf(item));
    }
    return `Skipped ${nameOf(item)}: ${this.wording.server} hasn't ${this.wording.verb} it yet`;
  }

  /** The scan's one summary line, with the first few names; none if none. */
  public summary(): { message: string; examples: string[] } | undefined {
    if (!this.films && !this.series) {
      return undefined;
    }
    return {
      message: unidentifiedSummary({
        ...this.wording,
        films: this.films,
        series: this.series,
      }),
      examples: [...this.names],
    };
  }
}
