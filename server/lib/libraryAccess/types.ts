import type {
  AccessLibrary,
  AccessPerson,
  AccessSet,
} from '@server/interfaces/api/libraryAccessInterfaces';

/** A server account plus the handle needed to change it. */
export interface ServerPerson extends AccessPerson {
  /** Server handle for their access (Plex share id). */
  ref: string;
}

export interface ServerAccess {
  libraries: AccessLibrary[];
  people: ServerPerson[];
  /** Each library's id as the scans know it (MediaLibraryItem), by its id here. */
  scanIds?: Map<string, string>;
}

/** Reads and changes library sharing on one media server. */
export interface AccessServer {
  /**
   * All libraries and people; `only` limits to one server id where supported.
   */
  read(only?: string): Promise<ServerAccess>;
  /**
   * Whether "all libraries, including future ones" can be set (not on Plex).
   */
  canGiveAll: boolean;
  /** Sets someone's libraries, or all. */
  write(
    person: ServerPerson,
    to: AccessSet,
    access: ServerAccess
  ): Promise<void>;
}

/** A refused library access change, with its HTTP status. */
export class LibraryAccessError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
