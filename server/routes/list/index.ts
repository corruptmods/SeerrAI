/**
 * Lists (watch lists and playlists): the lists, their titles, and importing,
 * each module registered on one router.
 */
import importRoutes from '@server/routes/list/import';
import itemRoutes from '@server/routes/list/items';
import listRoutes from '@server/routes/list/lists';
import playlistRoutes from '@server/routes/list/playlists';
import { Router } from 'express';

const router = Router();

// Order matters: items' and import's literal paths must match before lists'
// ":listId", or "/markers" would be read as a list id.
router.use(itemRoutes);
router.use(importRoutes);
router.use(playlistRoutes);
router.use(listRoutes);

export default router;
