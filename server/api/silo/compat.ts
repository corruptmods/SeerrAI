import type { SiloSystemInfo } from '@server/api/silo/types';

/*
 * Which Silo API Seerr AI speaks. Silo promises /api/v2 stays compatible for
 * as long as it reports api_major 2; any other major may change what Seerr AI
 * reads, so connecting, health checks and scans stop with a clear message
 * instead of guessing.
 */

export const SUPPORTED_API_MAJOR = 2;

/** Silo answered, but speaks an API major Seerr AI doesn't support. */
export class SiloIncompatibleError extends Error {
  constructor(public readonly apiMajor: number | undefined) {
    super(
      apiMajor === undefined || !Number.isFinite(apiMajor)
        ? `This server didn't say which Silo API it speaks. Seerr AI supports v${SUPPORTED_API_MAJOR}.`
        : `This Silo speaks API v${apiMajor}; Seerr AI supports v${SUPPORTED_API_MAJOR}.`
    );
    this.name = 'SiloIncompatibleError';
  }
}

/** Throws SiloIncompatibleError unless Silo speaks the supported major. */
export const assertCompatible = (info: Partial<SiloSystemInfo>): void => {
  if (info?.api_major !== SUPPORTED_API_MAJOR) {
    throw new SiloIncompatibleError(
      typeof info?.api_major === 'number' ? info.api_major : undefined
    );
  }
};

/**
 * Whether Silo's contract changed since `previous` was stored. Only for the
 * log: Silo says never to feature-detect on the digest.
 */
export const contractChanged = (
  previous: string | undefined,
  info: Pick<SiloSystemInfo, 'contract_digest'>
): boolean =>
  !!previous && !!info.contract_digest && previous !== info.contract_digest;
