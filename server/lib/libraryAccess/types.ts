import type {
  AccessLibrary,
  AccessPerson,
  AccessSet,
} from '@server/interfaces/api/libraryAccessInterfaces';

/** Someone on a server, with what the server needs to change them. */
export interface ServerPerson extends AccessPerson {
  /** The server's handle for their access: Plex's share id. */
  ref: string;
}

export interface ServerAccess {
  libraries: AccessLibrary[];
  people: ServerPerson[];
}

/** Reads and changes who sees which library on one media server. */
export interface AccessServer {
  /**
   * Every library and everyone it may be shared with. With `only`, just
   * that person (by their id on the server), where the server allows it.
   */
  read(only?: string): Promise<ServerAccess>;
  /**
   * Whether "every library, new ones too" can be given: Jellyfin and Emby
   * keep it as a switch, Plex only by inviting again.
   */
  canGiveAll: boolean;
  /** Gives someone exactly these libraries, or every one. */
  write(
    person: ServerPerson,
    to: AccessSet,
    access: ServerAccess
  ): Promise<void>;
}

/** Why a change to library access was refused, with the status to answer. */
export class LibraryAccessError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
