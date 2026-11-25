/**
 * Why a media server change was refused, with the response status. Kept apart
 * from mediaServerAdmin, which imports much of the server, so modules it
 * imports can still extend this class.
 */
export class MediaServerChangeError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
