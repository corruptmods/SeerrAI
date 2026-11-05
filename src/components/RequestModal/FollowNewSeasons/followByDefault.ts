interface FollowDefaultInput {
  /** Off means a series request always takes every season. */
  partialRequestsEnabled: boolean;
  selected: number[];
  /** Seasons not already requested or available. */
  requestable: number[];
  /** Seasons ticked for only some episodes. */
  partSeasons: number[];
  /** Newest season that has started airing; 0 if none. */
  latestAired: number;
}

/**
 * Whether "Also get new seasons" starts ticked: when the request takes every
 * season, or only the newest aired one. Specials are ignored.
 */
const followByDefault = ({
  partialRequestsEnabled,
  selected,
  requestable,
  partSeasons,
  latestAired,
}: FollowDefaultInput): boolean => {
  if (!partialRequestsEnabled) {
    return true;
  }

  const seasons = selected.filter((season) => season > 0);
  if (!seasons.length) {
    return false;
  }

  const everything =
    partSeasons.every((season) => season === 0) &&
    requestable
      .filter((season) => season > 0)
      .every((season) => seasons.includes(season));

  const newestOnly =
    latestAired > 0 && seasons.length === 1 && seasons[0] === latestAired;

  return everything || newestOnly;
};

export default followByDefault;
