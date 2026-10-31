import type { ArrKind } from '@server/lib/quality/types';

/*
 * TRaSH Guides' JSON files, read: what they hold, and which formats and
 * scores a profile uses. Plain data and functions only (no app imports),
 * so the pre-build review (bin/quality-review.mjs) runs the same code.
 * TRaSH Guides: https://trash-guides.info, MIT licence, copyright TRaSH.
 */

/** A custom format as TRaSH Guides writes it. */
export interface TrashFormat {
  trash_id: string;
  name: string;
  trash_scores?: Record<string, number>;
  includeCustomFormatWhenRenaming?: boolean;
  specifications: {
    name: string;
    implementation: string;
    negate: boolean;
    required: boolean;
    fields: Record<string, unknown>;
  }[];
}

export interface TrashProfile {
  trash_id: string;
  name: string;
  trash_score_set?: string;
  trash_quality_definition?: Record<string, string>;
  upgradeAllowed: boolean;
  cutoff: string;
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore?: number;
  /** Best first. */
  items: { name: string; allowed: boolean; items?: string[] }[];
  /** Format name → trash_id. */
  formatItems: Record<string, string>;
}

export interface TrashGroup {
  name: string;
  trash_id: string;
  default?: boolean | string;
  custom_formats: {
    name: string;
    trash_id: string;
    required?: boolean;
    default?: boolean | string;
  }[];
  quality_profiles?: { include?: Record<string, string> };
}

export interface TrashSize {
  trash_id: string;
  type: string;
  qualities: {
    quality: string;
    min: number;
    preferred: number;
    max: number;
  }[];
}

export interface TrashApp {
  formats: Record<string, TrashFormat>;
  profiles: Record<string, TrashProfile>;
  groups: TrashGroup[];
  /** Sets of formats that must not be used together, by trash_id. */
  conflicts: string[][];
  sizes: Record<string, TrashSize>;
}

export interface TrashData {
  commit: string;
  radarr: TrashApp;
  sonarr: TrashApp;
}

/**
 * The profile TRaSH Guides has for each preset, by trash_id. SD and 720p
 * have none: Seerr AI fills those in.
 */
export const TRASH_PROFILES: Record<
  ArrKind,
  Partial<Record<string, string>>
> = {
  radarr: {
    '1080p': 'd1d67249d3890e49bc12e275d989a7e9',
    '1080p-remux': '9ca12ea80aa55ef916e3751f4b874151',
    '2160p': '64fb5f9858489bdac2af690e27c8f42f',
    '2160p-remux': 'fd161a61e3ab826d3a22d53f935696dd',
    anime: '722b624f9af1e492284c4bc842153a38',
  },
  sonarr: {
    '1080p': '72dae194fc92bf828f32cde7744e51a1',
    '1080p-remux': 'fe9470e577c300a5ad9a3274f6d1cdf2',
    '2160p': 'd1498e7d189fbe6c7110ceaabb7473e6',
    '2160p-remux': '76a5053bdb2d1e4a8f16a69a37d46c12',
    anime: '20e0fc959f1f1704bed501f23bdae76f',
  },
};

export interface TrashMetadata {
  json_paths: Record<
    ArrKind,
    {
      custom_formats?: string[];
      quality_profiles?: string[];
      custom_format_groups?: string[];
      qualities?: string[];
      conflicts?: string[];
    }
  >;
}

export const inFolder = (file: string, folders: string[] = []) =>
  folders.some(
    (folder) =>
      file.startsWith(`${folder.replace(/\/$/, '')}/`) && file.endsWith('.json')
  );

export const compileTrashApp = (
  files: Record<string, unknown>,
  metadata: TrashMetadata,
  kind: ArrKind
): TrashApp => {
  const paths = metadata.json_paths[kind];
  const app: TrashApp = {
    formats: {},
    profiles: {},
    groups: [],
    conflicts: [],
    sizes: {},
  };
  for (const [file, value] of Object.entries(files)) {
    if (inFolder(file, paths.custom_formats)) {
      const format = value as TrashFormat;
      if (format?.trash_id) app.formats[format.trash_id] = format;
    } else if (inFolder(file, paths.quality_profiles)) {
      const profile = value as TrashProfile;
      if (profile?.trash_id) app.profiles[profile.trash_id] = profile;
    } else if (inFolder(file, paths.custom_format_groups)) {
      const group = value as TrashGroup;
      if (group?.trash_id) app.groups.push(group);
    } else if (inFolder(file, paths.qualities)) {
      const size = value as TrashSize;
      if (size?.trash_id) app.sizes[size.trash_id] = size;
    } else if ((paths.conflicts ?? []).includes(file)) {
      const sets =
        (value as { custom_formats?: Record<string, unknown>[] })
          ?.custom_formats ?? [];
      app.conflicts = sets.map((set) => Object.keys(set));
    }
  }
  app.groups.sort((a, b) => a.name.localeCompare(b.name));
  return app;
};

/** A TRaSH Guides format as Radarr and Sonarr take one. */
export const toArrFormat = (format: TrashFormat, name: string) => ({
  name,
  includeCustomFormatWhenRenaming:
    format.includeCustomFormatWhenRenaming ?? false,
  specifications: format.specifications.map((spec) => ({
    name: spec.name,
    implementation: spec.implementation,
    negate: spec.negate,
    required: spec.required,
    fields: Object.entries(spec.fields ?? {}).map(([field, value]) => ({
      name: field,
      value,
    })),
  })),
});

/** Whether a group's or a format's `default` says on. */
const on = (value: boolean | string | undefined) =>
  value === true || value === 'true';

/**
 * The formats a TRaSH Guides profile uses: its own, and those of the
 * groups it is included in by default (each group's required formats and
 * those on by default).
 */
export const trashProfileFormats = (
  app: TrashApp,
  profile: TrashProfile
): { trashId: string; group?: string }[] => {
  const seen = new Set<string>();
  const out: { trashId: string; group?: string }[] = [];
  for (const id of Object.values(profile.formatItems ?? {})) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ trashId: id });
    }
  }
  for (const group of app.groups) {
    if (!on(group.default)) continue;
    const included = Object.values(group.quality_profiles?.include ?? {});
    if (!included.includes(profile.trash_id)) continue;
    for (const format of group.custom_formats) {
      if (!format.required && !on(format.default)) continue;
      if (seen.has(format.trash_id)) continue;
      seen.add(format.trash_id);
      out.push({ trashId: format.trash_id, group: group.name });
    }
  }
  return out;
};

/** A format's TRaSH Guides score in a profile's score set. */
export const trashScore = (
  format: TrashFormat,
  scoreSet: string | undefined
): number =>
  (scoreSet && format.trash_scores?.[scoreSet] !== undefined
    ? format.trash_scores[scoreSet]
    : format.trash_scores?.default) ?? 0;
