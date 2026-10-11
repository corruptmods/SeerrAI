import logger from '@server/logger';
import type { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';

// Routes worth having ready before anyone navigates. Everything else loads on
// demand as before; precaching all 90+ routes would push ~9 MB per deploy.
const CORE_ROUTES = [
  '/',
  '/_app',
  '/_error',
  '/discover/movies',
  '/discover/tv',
  '/movie/[movieId]',
  '/tv/[tvId]',
  '/requests',
  '/lists',
  '/lists/[listId]',
  '/search',
  '/profile',
];

interface BuildManifest {
  pages: Record<string, string[]>;
  rootMainFiles?: string[];
}

let cached: { files: string[]; loadedAt: number } | null = null;

/**
 * Lists the static chunks the service worker should precache on install, read
 * from the build manifest Next.js writes. Served outside /api so the OpenAPI
 * validator does not apply; it carries no user data.
 */
export const swPrecacheHandler = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!cached) {
      const manifestPath = path.join(
        __dirname,
        '../../.next/build-manifest.json'
      );
      const manifest = JSON.parse(
        await fs.readFile(manifestPath, 'utf-8')
      ) as BuildManifest;

      const files = new Set<string>();

      for (const route of CORE_ROUTES) {
        for (const chunk of manifest.pages[route] ?? []) {
          files.add(`/_next/${chunk}`);
        }
      }

      for (const chunk of manifest.rootMainFiles ?? []) {
        files.add(`/_next/${chunk}`);
      }

      cached = { files: [...files], loadedAt: Date.now() };
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json({ files: cached.files });
  } catch (e) {
    logger.warn('Could not read build manifest for precache list', {
      label: 'Service Worker',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    res.status(200).json({ files: [] });
  }
};

export default swPrecacheHandler;
