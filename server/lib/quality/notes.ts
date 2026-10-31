import { getRepository } from '@server/datasource';
import QualityGrabNote from '@server/entity/QualityGrabNote';
import type { ArrRelease } from '@server/lib/autofix/arr';
import type { ArrKind } from '@server/lib/quality/types';
import { MoreThan } from 'typeorm';

/*
 * Notes on the releases Seerr AI grabs through Radarr and Sonarr itself:
 * what each was chosen over. Radarr and Sonarr keep only the release
 * grabbed, so What it does can say a grab won a tie only for these.
 */

const protocolOf = (release: ArrRelease): 'usenet' | 'torrent' | null => {
  const protocol = (release.protocol ?? '').toLowerCase();
  return protocol.includes('usenet')
    ? 'usenet'
    : protocol.includes('torrent')
      ? 'torrent'
      : null;
};

/** Notes a grab, from the releases that were on offer with it. */
export const noteGrab = async (
  kind: ArrKind,
  serverId: number,
  guid: string,
  offered: ArrRelease[]
): Promise<void> => {
  const picked = offered.find((r) => r.guid === guid);
  if (!picked) return;
  const protocol = protocolOf(picked);
  const wonTie =
    !!protocol &&
    offered.some(
      (r) =>
        r.guid !== guid &&
        !r.rejected &&
        protocolOf(r) !== null &&
        protocolOf(r) !== protocol &&
        r.quality?.quality.id === picked.quality?.quality.id &&
        (r.customFormatScore ?? 0) === (picked.customFormatScore ?? 0)
    );
  await getRepository(QualityGrabNote).save(
    new QualityGrabNote({
      serverKind: kind,
      serverId,
      title: picked.title,
      protocol,
      wonTie,
    })
  );
};

/** Notes on grabs of these release names in the last few weeks. */
export const notesFor = async (
  kind: ArrKind,
  serverId: number,
  since: Date
): Promise<Map<string, QualityGrabNote>> => {
  const notes = await getRepository(QualityGrabNote).find({
    where: { serverKind: kind, serverId, createdAt: MoreThan(since) },
    order: { id: 'DESC' },
  });
  const out = new Map<string, QualityGrabNote>();
  for (const note of notes) {
    if (!out.has(note.title)) out.set(note.title, note);
  }
  return out;
};
