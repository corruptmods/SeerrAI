import { lidarrSendsSettled } from '@server/subscriber/MediaRequestSubscriber';
import { resetTestDb, seedTestDb } from '@server/utils/seedTestDb';
import { before, beforeEach } from 'node:test';

export function setupTestDb() {
  before(async () => {
    await seedTestDb();
  });
  beforeEach(async () => {
    // A Lidarr send still under way from the last test would land on the
    // fresh tables, whose rows are numbered from 1 again.
    await lidarrSendsSettled();
    await resetTestDb();
  });
}
