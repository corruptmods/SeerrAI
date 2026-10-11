/**
 * Where a download stands, from the moment Radarr or Sonarr has it until it
 * is imported, for every download client alike (all report through the
 * same queue fields).
 *
 * - waiting: held by a delay profile in case a better release turns up
 * - queued: waiting its turn in the download client, or being checked
 *   before it starts
 * - paused: paused in the download client
 * - downloading: bytes still arriving
 * - stalled: not downloading right now (a torrent with no one to download
 *   from, or one the client has stopped on an error)
 * - finishing: all bytes are in and the client is getting it ready:
 *   a Usenet client verifying, repairing, unpacking or running its script,
 *   a torrent client moving or re-checking it
 * - importing: the client is done (a torrent may be seeding) and Radarr
 *   or Sonarr is importing it, or about to
 * - needsAttention: Radarr or Sonarr won't import it on its own (a manual
 *   import is needed, it doesn't match, unpacking failed) or the download
 *   client can't be reached
 * - failed: the download failed, and Radarr or Sonarr will search again
 * - imported: Radarr or Sonarr imported it, and the media server has not
 *   listed it yet; shown for a while after it leaves the queue
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
 * What a download client is doing within a stage, when it says: only a
 * download client read directly can tell these apart.
 *
 * - verifying, repairing, unpacking, moving, script: a Usenet client's
 *   steps after downloading (script is its post-processing script)
 * - checking: a torrent client checking a torrent's pieces
 * - metadata: a torrent client fetching a torrent's details before it
 *   starts
 * - noPeers: a torrent with no one to download from
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
