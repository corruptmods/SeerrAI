import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blocklistAction } from './blocklistAction';

const admin = { canManageBlocklist: true, isAdmin: true };
const moderator = { canManageBlocklist: true, isAdmin: false };
const requester = { canManageBlocklist: false, isAdmin: false };

const held = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
  MediaStatus.AVAILABLE,
];
const notHeld = [undefined, MediaStatus.UNKNOWN, MediaStatus.DELETED];

/**
 * Who sees the blocklist button on a media page, and whether it deletes
 * files. Blocklisting a requested or downloaded title removes it from the
 * *arr and deletes its files, so that case is admin only.
 */
describe('the blocklist button on a media page', () => {
  it('lets an admin blocklist a title in any state, deleting files when held', () => {
    for (const status of held) {
      assert.deepEqual(blocklistAction(status, admin), {
        show: true,
        removesFiles: true,
      });
    }

    for (const status of notHeld) {
      assert.deepEqual(blocklistAction(status, admin), {
        show: true,
        removesFiles: false,
      });
    }
  });

  it('keeps upstream behaviour for a non-admin who can manage the blocklist', () => {
    for (const status of notHeld) {
      assert.equal(blocklistAction(status, moderator).show, true);
    }

    for (const status of held) {
      assert.equal(
        blocklistAction(status, moderator).show,
        false,
        'deleting files is admin only'
      );
    }
  });

  it('never shows for something already blocklisted', () => {
    assert.equal(blocklistAction(MediaStatus.BLOCKLISTED, admin).show, false);
  });

  it('never shows without blocklist permission', () => {
    for (const status of [...held, ...notHeld]) {
      assert.equal(blocklistAction(status, requester).show, false);
    }
  });
});
