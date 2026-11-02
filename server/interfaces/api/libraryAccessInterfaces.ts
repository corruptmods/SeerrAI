import type { MediaServerKind } from '@server/constants/server';

/*
 * Who sees which library on each media server, as Settings → Media
 * Servers and a person's Libraries page show it (routes/settings/
 * libraryAccess).
 */

export type AccessLibraryType = 'movie' | 'show' | 'music' | 'photo' | 'other';

export interface AccessLibrary {
  /** The server's id for it, as access lists it. */
  id: string;
  title: string;
  type: AccessLibraryType;
}

/** What one person may see. */
export interface AccessSet {
  /** Every library, new ones too. */
  all: boolean;
  /** The libraries they have; every one when `all`. */
  libraries: string[];
}

/** Someone a server is shared with, or an account on it. */
export interface AccessPerson extends AccessSet {
  /** Their id on the server. */
  id: string;
  name: string;
  /** Their Seerr AI account, when one is linked. */
  userId?: number;
  /** An administrator on Jellyfin or Emby: sees everything, never changed. */
  admin?: boolean;
  /** The account is switched off on the server. */
  disabled?: boolean;
}

export interface LibraryAccessView {
  kind: MediaServerKind;
  libraries: (AccessLibrary & {
    /** How many of `people` (administrators left out) have it. */
    sharedWith: number;
  })[];
  people: AccessPerson[];
}

/** Take a library away from everyone, or give it to everyone. */
export type AccessBulkAction = 'remove' | 'add';

export interface AccessPlanPerson {
  id: string;
  name: string;
  userId?: number;
}

/** What a bulk change would do, before it is made. */
export interface AccessPlan {
  kind: MediaServerKind;
  library: AccessLibrary;
  action: AccessBulkAction;
  /** Who would change. */
  change: AccessPlanPerson[];
  /** Of those, who had every library: they stop getting new ones. */
  fromAll: number;
  /** Who would be left with no library, and so is left as they are. */
  emptied: AccessPlanPerson[];
  /** Who already is as asked. */
  unchanged: number;
  /** Administrators, who always see everything. */
  admins: number;
}

/** One change made here, for its history and Undo. */
export interface AccessChangeView {
  id: number;
  kind: MediaServerKind;
  /** A bulk change, or one person's libraries. */
  action: AccessBulkAction | 'person';
  libraryTitle?: string;
  /** For one person's change: who. */
  personName?: string;
  byName?: string;
  createdAt: string;
  undoneAt?: string;
  changed: number;
  failed: number;
}

/** What a bulk change or an Undo did. */
export interface AccessResult {
  change?: AccessChangeView;
  changed: number;
  failed: { name: string; error: string }[];
  /** Undo: people no longer on the server, or changed since. */
  skipped?: number;
}

/** A person's libraries on one server they have an account on. */
export interface UserLibraryAccess {
  kind: MediaServerKind;
  libraries: AccessLibrary[];
  /** "Every library, new ones too" can be given (Jellyfin and Emby). */
  canGiveAll: boolean;
  /** Missing when the server does not list them (not shared, or gone). */
  person?: AccessPerson;
  /** The server could not be read. */
  error?: string;
}
