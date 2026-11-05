/**
 * A download's stage from when Radarr or Sonarr has it until import, the same
 * for every download client (all report through the same queue fields).
 *
 * - waiting: held by a delay profile in case a better release appears
 * - queued: waiting in the download client, or being checked before starting
 * - paused: paused in the download client
 * - downloading: bytes still arriving
 * - stalled: not downloading now (a torrent with no peers, or stopped by the
 *   client on an error)
 * - finishing: all bytes in and the client is preparing it: a Usenet client
 *   verifying, repairing, unpacking or running its script, a torrent client
 *   moving or rechecking it
 * - importing: the client is done (a torrent may be seeding) and Radarr or
 *   Sonarr is importing it, or about to
 * - needsAttention: Radarr or Sonarr won't import it unaided (manual import
 *   needed, no match, unpacking failed) or the download client is unreachable
 * - failed: the download failed, and Radarr or Sonarr will search again
 * - imported: imported, but not yet listed by the media server; shown for a
 *   while after leaving the queue
 */
export type DownloadStage =
  | 'waiting'
  | 'queued'
  | 'paused'
  | 'downloading'
  | 'stalled'
  | 'finishing'
  | 'importing'
  | 'needsAttention'
  | 'failed'
  | 'imported';

/**
 * What a download client is doing within a stage, when known; only clients read
 * directly report these.
 *
 * - verifying, repairing, unpacking, moving, script: a Usenet client's
 *   post-download steps (script is its post-processing script)
 * - checking: a torrent client checking pieces
 * - metadata: a torrent client fetching torrent details before starting
 * - noPeers: a torrent with no peers
 */
export type DownloadStep =
  | 'verifying'
  | 'repairing'
  | 'unpacking'
  | 'moving'
  | 'script'
  | 'checking'
  | 'metadata'
  | 'noPeers';
