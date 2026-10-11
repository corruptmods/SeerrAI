import TheMovieDb from '@server/api/themoviedb';
import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * Commenting on an issue notifies the people involved. The subscriber used
 * to look the new comment up on a different connection from the save that
 * created it — one that cannot see the row until it commits — so the lookup
 * failed and the notification never went out. Upstream fix 6fb4c239.
 */

setupTestDb();

let sent: Notification[] = [];

Object.defineProperty(notificationManager, 'sendNotification', {
  configurable: true,
  value: (type: Notification) => {
    sent.push(type);
  },
});

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ id: 910, title: 'Film', poster_path: null });
  },
});

describe('issue comment notifications', () => {
  beforeEach(() => {
    sent = [];
  });

  it('sends one when someone replies on an issue', async () => {
    await getRepository(User).save(
      new User({
        email: 'reporter@test.local',
        plexUsername: 'reporter',
        permissions: Permission.CREATE_ISSUES,
        avatar: '',
      })
    );
    const reporter = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'reporter' },
    });

    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 910,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );

    const issue = await getRepository(Issue).save(
      new Issue({
        issueType: IssueType.VIDEO,
        status: IssueStatus.OPEN,
        media,
        createdBy: reporter,
      })
    );

    // The first comment is the issue's description, which the issue-created
    // notification already covers. A reply is what notifies.
    await getRepository(IssueComment).save(
      new IssueComment({
        issue,
        user: reporter,
        message: 'Audio is out of sync',
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    sent = [];

    await getRepository(IssueComment).save(
      new IssueComment({
        issue,
        user: reporter,
        message: 'Still happening after a restart',
      })
    );

    // The subscriber used not to await its work either.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(
      sent.includes(Notification.ISSUE_COMMENT),
      `expected an issue comment notification, got ${JSON.stringify(sent)}`
    );
  });
});
