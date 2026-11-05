import type { MediaServerKind } from '@server/constants/server';

/*
 * Per-server library access, for Settings → Media Servers and a user's
 * Libraries page (routes/settings/libraryAccess).
 */

export type AccessLibraryType = 'movie' | 'show' | 'music' | 'photo' | 'other';

export interface AccessLibrary {
  /** The server's id, as access lists use it. */
  id: string;
  title: string;
  type: AccessLibraryType;
}

/** The libraries one user may see. */
export interface AccessSet {
  /** Every library, including new ones. */
  all: boolean;
  /** Every one when `all`. */
  libraries: string[];
}

/** A user the server is shared with, or an account on it. */
export interface AccessPerson extends AccessSet {
  /** Server-side id. */
  id: string;
  name: string;
  /** Linked Seerr AI user, if any. */
  userId?: number;
  /** Jellyfin/Emby administrator: sees everything, never changed. */
  admin?: boolean;
  /** Disabled on the server. */
  disabled?: boolean;
}

export interface LibraryAccessView {
  kind: MediaServerKind;
  libraries: (AccessLibrary & {
    /** Count of `people` (excluding administrators) with access. */
    sharedWith: number;
  })[];
  people: AccessPerson[];
}

/** Remove a library from, or add it to, everyone. */
export type AccessBulkAction = 'remove' | 'add';

export interface AccessPlanPerson {
  id: string;
  name: string;
  userId?: number;
}

/** Preview of a bulk change. */
export interface AccessPlan {
  kind: MediaServerKind;
  library: AccessLibrary;
  action: AccessBulkAction;
  change: AccessPlanPerson[];
  /** Of `change`, those who had every library and stop getting new ones. */
  fromAll: number;
  /** Left unchanged because they would end up with no library. */
  emptied: AccessPlanPerson[];
  /** Already as requested. */
  unchanged: number;
  /** Administrators, who always see everything. */
  admins: number;
}

/** One recorded change, for history and Undo. */
export interface AccessChangeView {
  id: number;
  kind: MediaServerKind;
  /** A bulk change, or one user's libraries. */
  action: AccessBulkAction | 'person';
  libraryTitle?: string;
  /** For a 'person' change: whose. */
  personName?: string;
  byName?: string;
  createdAt: string;
  undoneAt?: string;
  changed: number;
  failed: number;
}

/** Result of a bulk change or Undo. */
export interface AccessResult {
  change?: AccessChangeView;
  changed: number;
  failed: { name: string; error: string }[];
  /** Undo: users gone from the server or changed since. */
  skipped?: number;
}

/** A user's libraries on one server where they have an account. */
export interface UserLibraryAccess {
  kind: MediaServerKind;
  libraries: AccessLibrary[];
  /** "Every library" can be granted (Jellyfin and Emby). */
  canGiveAll: boolean;
  /** Missing when the server doesn't list them (not shared, or gone). */
  person?: AccessPerson;
  /** Set when the server could not be read. */
  error?: string;
}
