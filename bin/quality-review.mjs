/*
 * Seerr AI's own quality presets against TRaSH Guides, before every build
 * (quality-check.sh, which build.sh runs). Says what changed in TRaSH Guides
 * since the presets were last reviewed against it, and what the presets
 * could take from it. A report only: it never stops a build.
 *
 *   node --experimental-strip-types --no-warnings bin/quality-review.mjs
 *     [--cache DIR]  keep fetched files here, so only changed ones are fetched
 *     [--accept]     record the current TRaSH Guides as reviewed
 *
 * The review is kept in server/lib/quality/trash-reviewed.json. It reads
 * TRaSH Guides with the same code the app does (trashData.ts).
 * TRaSH Guides: https://trash-guides.info, MIT licence, copyright TRaSH.
 */
// A command-line script run by bare Node.js: it prints, and can't use the
// app's @server/ paths.
/* eslint-disable no-console, no-relative-import-paths/no-relative-import-paths */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAST_RESORT,
  PRESET_LABELS,
  TRASH_EQUIVALENTS,
} from '../server/lib/quality/presets.ts';
import {
  TRASH_PROFILES,
  compileTrashApp,
  inFolder,
  trashProfileFormats,
  trashScore,
} from '../server/lib/quality/trashData.ts';

const REPO = 'TRaSH-Guides/Guides';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWED = path.join(ROOT, 'server/lib/quality/trash-reviewed.json');
const KINDS = ['radarr', 'sonarr'];
const APP = { radarr: 'Radarr', sonarr: 'Sonarr' };
const SIZES = { radarr: 'movie', sonarr: 'series' };

const args = process.argv.slice(2);
const accept = args.includes('--accept');
const cacheAt = args.indexOf('--cache');
const cache = cacheAt >= 0 ? args[cacheAt + 1] : null;

const get = async (url, json = true) => {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Seerr AI quality review',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return json ? res.json() : res.text();
};

/** TRaSH Guides at its newest commit, read as the app reads it. */
const fetchTrash = async () => {
  const head = await get(`https://api.github.com/repos/${REPO}/commits/master`);
  const commit = head.sha;
  const raw = (file) =>
    get(`https://raw.githubusercontent.com/${REPO}/${commit}/${file}`, false);
  const metadata = JSON.parse(await raw('metadata.json'));
  const tree = await get(
    `https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`
  );
  const wanted = tree.tree.filter(
    (entry) =>
      entry.type === 'blob' &&
      KINDS.some((kind) => {
        const p = metadata.json_paths[kind];
        return (
          inFolder(entry.path, p.custom_formats) ||
          inFolder(entry.path, p.quality_profiles) ||
          inFolder(entry.path, p.custom_format_groups) ||
          inFolder(entry.path, p.qualities) ||
          (p.conflicts ?? []).includes(entry.path)
        );
      })
  );
  const files = {};
  for (let i = 0; i < wanted.length; i += 16) {
    await Promise.all(
      wanted.slice(i, i + 16).map(async (entry) => {
        const kept = cache && path.join(cache, `${entry.sha}.json`);
        let text = kept && (await fs.readFile(kept, 'utf8').catch(() => null));
        if (!text) {
          text = await raw(entry.path);
          if (kept) await fs.writeFile(kept, text);
        }
        files[entry.path] = JSON.parse(text);
      })
    );
  }
  return {
    commit,
    date: head.commit?.committer?.date ?? null,
    radarr: compileTrashApp(files, metadata, 'radarr'),
    sonarr: compileTrashApp(files, metadata, 'sonarr'),
  };
};

const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const sorted = (values) => [...new Set(values)].sort();

/** What the review compares, per app. */
const factsOf = (trash) =>
  Object.fromEntries(
    KINDS.map((kind) => {
      const app = trash[kind];
      const byName = Object.fromEntries(
        Object.values(app.formats).map((f) => [f.name, f])
      );
      const never = [];
      for (const id of Object.values(TRASH_PROFILES[kind])) {
        const profile = app.profiles[id];
        if (!profile) continue;
        for (const { trashId } of trashProfileFormats(app, profile)) {
          const format = app.formats[trashId];
          if (
            format &&
            trashScore(format, profile.trash_score_set) <= LAST_RESORT
          ) {
            never.push(format.name);
          }
        }
      }
      const mirrored = {};
      for (const names of Object.values(TRASH_EQUIVALENTS[kind])) {
        for (const name of names) {
          mirrored[name] = byName[name]
            ? hash(byName[name].specifications)
            : 'missing';
        }
      }
      const sizes = {};
      for (const size of Object.values(app.sizes)) {
        if (size.type !== SIZES[kind]) continue;
        for (const q of size.qualities) {
          sizes[q.quality] = [q.min, q.preferred, q.max];
        }
      }
      const qualities = Object.values(app.profiles).flatMap((p) =>
        p.items.flatMap((item) => [item.name, ...(item.items ?? [])])
      );
      return [
        kind,
        {
          profiles: Object.fromEntries(
            Object.values(app.profiles)
              .map((p) => [p.trash_id, p.name])
              .sort((a, b) => a[1].localeCompare(b[1]))
          ),
          qualities: sorted(qualities),
          never: sorted(never),
          mirrored,
          sizes,
        },
      ];
    })
  );

const added = (now = [], was = []) => now.filter((v) => !was.includes(v));
const list = (values) => values.join(', ');

const review = (facts, was) => {
  const mustFix = [];
  const changed = [];
  for (const kind of KINDS) {
    const app = APP[kind];
    const now = facts[kind];
    const before = was?.[kind];
    for (const [preset, id] of Object.entries(TRASH_PROFILES[kind])) {
      if (!now.profiles[id]) {
        mustFix.push(
          `${app}: TRaSH Guides no longer has the profile Seerr AI uses for ${PRESET_LABELS[preset]} (${id}). TRASH_PROFILES in trashData.ts needs its new one.`
        );
      }
    }
    for (const [name, h] of Object.entries(now.mirrored)) {
      if (h === 'missing') {
        mustFix.push(
          `${app}: TRaSH Guides has no format named "${name}" any more; TRASH_EQUIVALENTS in presets.ts needs its new name.`
        );
      }
    }
    if (!before) continue;
    const newProfiles = added(
      Object.values(now.profiles),
      Object.values(before.profiles)
    );
    const goneProfiles = added(
      Object.values(before.profiles),
      Object.values(now.profiles)
    );
    if (newProfiles.length) {
      changed.push(
        `${app}: new TRaSH Guides profiles: ${list(newProfiles)}. One may suit a preset Seerr AI fills in (SD, 720p).`
      );
    }
    if (goneProfiles.length) {
      changed.push(`${app}: profiles removed: ${list(goneProfiles)}.`);
    }
    const newQualities = added(now.qualities, before.qualities);
    if (newQualities.length) {
      changed.push(
        `${app}: new qualities in TRaSH Guides' profiles: ${list(newQualities)}. Seerr AI's ladders (presets.ts) may want them.`
      );
    }
    const newNever = added(now.never, before.never);
    const noLonger = added(before.never, now.never);
    if (newNever.length) {
      changed.push(
        `${app}: TRaSH Guides now never takes: ${list(newNever)}. Should Seerr AI's own presets?`
      );
    }
    if (noLonger.length) {
      changed.push(
        `${app}: TRaSH Guides no longer refuses: ${list(noLonger)}.`
      );
    }
    for (const [key, names] of Object.entries(TRASH_EQUIVALENTS[kind])) {
      for (const name of names) {
        if (
          before.mirrored[name] &&
          now.mirrored[name] !== 'missing' &&
          now.mirrored[name] !== before.mirrored[name]
        ) {
          changed.push(
            `${app}: "${name}" matches differently now; Seerr AI's ${key} (presets.ts) does the same work and may need the same change.`
          );
        }
      }
    }
    const sizeChanges = Object.keys({ ...now.sizes, ...before.sizes }).filter(
      (q) => JSON.stringify(now.sizes[q]) !== JSON.stringify(before.sizes[q])
    );
    if (sizeChanges.length) {
      changed.push(
        `${app}: TRaSH Guides' sizes changed for ${list(
          sizeChanges.map(
            (q) =>
              `${q} (${(before.sizes[q] ?? ['-']).join('/')} → ${(now.sizes[q] ?? ['-']).join('/')})`
          )
        )}; compare Seerr AI's size limits in presets.ts.`
      );
    }
  }
  return { mustFix, changed };
};

/** TRaSH Guides never takes these, and Seerr AI's own presets have none like them. */
const gaps = (facts) =>
  KINDS.map((kind) => {
    const ours = Object.values(TRASH_EQUIVALENTS[kind]).flat();
    const missing = facts[kind].never.filter((name) => !ours.includes(name));
    return missing.length ? `${APP[kind]}: ${list(missing)}` : null;
  }).filter(Boolean);

const short = (commit) => (commit ?? '').slice(0, 7);
const day = (date) => (date ? date.slice(0, 10) : 'unknown date');

const main = async () => {
  if (cache) await fs.mkdir(cache, { recursive: true });
  const was = JSON.parse(
    await fs.readFile(REVIEWED, 'utf8').catch(() => 'null')
  );
  const trash = await fetchTrash();
  const facts = factsOf(trash);

  if (accept) {
    await fs.writeFile(
      REVIEWED,
      JSON.stringify(
        { commit: trash.commit, date: trash.date, facts },
        null,
        2
      ) + '\n'
    );
    console.log(
      `Recorded TRaSH Guides ${short(trash.commit)} (${day(trash.date)}) as reviewed.`
    );
    return;
  }

  console.log('Quality presets against TRaSH Guides:');
  console.log(
    `TRaSH Guides ${short(trash.commit)} (${day(trash.date)}); last reviewed ${
      was ? `${short(was.commit)} (${day(was.date)})` : 'never'
    }.`
  );
  const { mustFix, changed } = review(facts, was?.facts);
  if (mustFix.length) {
    console.log('\nMust fix (TRaSH Guides presets would stop working):');
    for (const line of mustFix) console.log(`  - ${line}`);
  }
  if (changed.length) {
    console.log('\nChanged since the last review:');
    for (const line of changed) console.log(`  - ${line}`);
  }
  const standing = gaps(facts);
  if (standing.length) {
    console.log(
      '\nTRaSH Guides never takes these; Seerr AI’s own presets have nothing like them:'
    );
    for (const line of standing) console.log(`  - ${line}`);
  }
  if (!was) {
    console.log(
      '\nNot reviewed yet. Once Seerr AI’s presets have been checked against it, record it:'
    );
    console.log('  QUALITY_CHECK_HERE=1 ./quality-check.sh --accept');
  } else if (!mustFix.length && !changed.length) {
    console.log(
      was && was.commit === trash.commit
        ? '\nNothing new since the last review.'
        : '\nNothing that touches Seerr AI’s presets changed since the last review.'
    );
  } else {
    console.log(
      '\nReview Seerr AI’s presets (server/lib/quality/presets.ts) against this, then record it:'
    );
    console.log('  QUALITY_CHECK_HERE=1 ./quality-check.sh --accept');
  }
};

main().catch((e) => {
  console.log(`Could not check TRaSH Guides: ${e.message}`);
});
