interface FollowDefaultInput {
  /** Off: a series request always takes every season, with no choice. */
  partialRequestsEnabled: boolean;
  /** Seasons ticked in the dialog. */
  selected: number[];
  /** Seasons that could be requested here: not requested or here already. */
  requestable: number[];
  /** Seasons ticked for only some of their episodes. */
  partSeasons: number[];
  /** The newest season that has started airing, or 0 if none has. */
  latestAired: number;
}

/**
 * Whether "Also get new seasons" starts ticked. It does when the request
 * already takes everything there is to take, since the next season is the
 * only thing left to want, and when only the newest season is ticked, which
 * is asking for the series from here on. Specials do not count either way.
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
