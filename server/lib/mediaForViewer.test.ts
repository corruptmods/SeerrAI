import { MediaRequestStatus } from '@server/constants/media';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import mediaForViewer from '@server/lib/mediaForViewer';
import { Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * What a title page reveals about the people who requested it or reported
 * problems with it, depending on who is looking.
 */

const person = (id: number, email: string, permissions = Permission.REQUEST) =>
  new User({
    id,
    email,
    plexId: 1000 + id,
    plexUsername: `user${id}`,
    permissions,
    plexTokenExpiredAt: new Date(),
  });

const title = () => {
  const requester = person(1, 'requester@example.com');
  const reporter = person(2, 'reporter@example.com');
  return new Media({
    requests: [
      new MediaRequest({ requestedBy: requester, modifiedBy: requester }),
    ],
    issues: [
      new Issue({
        createdBy: reporter,
        comments: [
          new IssueComment({ user: reporter, message: 'private details' }),
        ],
      }),
    ],
  });
};

describe('a title seen by different people', () => {
  it('shows others who requested it, but not their email or Plex id', () => {
    const media = mediaForViewer(title(), person(3, 'viewer@example.com'));
    const requester = media?.requests[0].requestedBy as Partial<User>;
    assert.equal(requester.id, 1);
    assert.equal(requester.plexUsername, 'user1');
    assert.equal(requester.email, undefined);
    assert.equal(requester.plexId, undefined);
    assert.equal(requester.plexTokenExpiredAt, undefined);
    assert.equal(
      (media?.requests[0].modifiedBy as Partial<User>).email,
      undefined
    );
  });

  it('keeps reported issues from those not allowed to see issues', () => {
    const media = mediaForViewer(title(), person(3, 'viewer@example.com'));
    assert.deepEqual(media?.issues, []);
  });

  it('shows issues to those who may see them, still without emails', () => {
    const media = mediaForViewer(
      title(),
      person(3, 'viewer@example.com', Permission.VIEW_ISSUES)
    );
    assert.equal(media?.issues.length, 1);
    assert.equal(
      (media?.issues[0].createdBy as Partial<User>).email,
      undefined
    );
    assert.equal(
      (media?.issues[0].comments[0].user as Partial<User>).email,
      undefined
    );
  });

  it('shows everything to someone who manages users', () => {
    const media = mediaForViewer(
      title(),
      person(3, 'admin@example.com', Permission.ADMIN)
    );
    assert.equal(
      (media?.requests[0].requestedBy as Partial<User>).email,
      'requester@example.com'
    );
    assert.equal(
      (media?.issues[0].createdBy as Partial<User>).email,
      'reporter@example.com'
    );
  });

  it('keeps what the title page lists of each request for anyone', () => {
    // The page's "Requested by": who, with their picture, for what, how it
    // stands and when.
    const requester = person(1, 'requester@example.com');
    requester.avatar = '/avatar/1.png';
    requester.setDisplayName();
    const createdAt = new Date('2026-10-01T12:00:00Z');
    const media = mediaForViewer(
      new Media({
        requests: [
          new MediaRequest({
            id: 7,
            requestedBy: requester,
            status: MediaRequestStatus.APPROVED,
            is4k: true,
            createdAt,
            seasons: [
              new SeasonRequest({ seasonNumber: 1 }),
              new SeasonRequest({ seasonNumber: 2 }),
            ],
          }),
        ],
        issues: [],
      }),
      person(3, 'viewer@example.com')
    );
    const [request] = media?.requests ?? [];
    const shown = request.requestedBy as Partial<User>;
    assert.equal(shown.id, 1);
    assert.equal(shown.displayName, 'user1');
    assert.equal(shown.avatar, '/avatar/1.png');
    assert.equal(request.status, MediaRequestStatus.APPROVED);
    assert.equal(request.is4k, true);
    assert.equal(request.createdAt, createdAt);
    assert.deepEqual(
      request.seasons.map((s) => s.seasonNumber),
      [1, 2]
    );
  });
});
