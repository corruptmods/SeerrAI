/**
 * Lists: watch lists, and playlists.
 *
 * Split by concern: the lists themselves, the titles on them, and importing.
 * Each module registers onto the same router.
 */
import importRoutes from '@server/routes/list/import';
import itemRoutes from '@server/routes/list/items';
import listRoutes from '@server/routes/list/lists';
import playlistRoutes from '@server/routes/list/playlists';
import { Router } from 'express';

const router = Router();

// Order matters: the literal paths in items and import must be matched before
// the ":listId" patterns in lists, or "/markers" would be read as a list id.
router.use(itemRoutes);
router.use(importRoutes);
router.use(playlistRoutes);
router.use(listRoutes);

export default router;
