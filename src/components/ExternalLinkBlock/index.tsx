import EmbyLogo from '@app/assets/services/emby.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import JellyfinLogo from '@app/assets/services/jellyfin.svg';
import LetterboxdLogo from '@app/assets/services/letterboxd.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import RTLogo from '@app/assets/services/rt.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TmdbLogo from '@app/assets/services/tmdb.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import TvdbLogo from '@app/assets/services/tvdb.svg';
import useLocale from '@app/hooks/useLocale';
import type { PlayLink } from '@app/utils/playLinks';
import { MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';

const SERVER_LOGOS: Record<
  MediaServerKind,
  React.FC<React.SVGProps<SVGSVGElement>>
> = {
  plex: PlexLogo,
  jellyfin: JellyfinLogo,
  emby: EmbyLogo,
};

type ExternalLinkType = 'movie' | 'tv' | 'person';

interface ExternalLinkBlockProps {
  mediaType: ExternalLinkType;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  rtUrl?: string;
  /** The title on each media server that has it (usePlayLinks). */
  playLinks?: PlayLink[];
}

const ExternalLinkBlock = ({
  mediaType,
  tmdbId,
  tvdbId,
  imdbId,
  rtUrl,
  playLinks = [],
}: ExternalLinkBlockProps) => {
  const { locale } = useLocale();

  return (
    <div className="flex w-full items-center justify-center space-x-2 sm:space-x-5">
      {playLinks.map((link) => {
        const url = link.url ?? link.url4k;
        if (!url) {
          return null;
        }
        const Logo = SERVER_LOGOS[link.server];
        return (
          <a
            key={link.server}
            href={url}
            aria-label={link.name}
            className="external-link w-12"
            target="_blank"
            rel="noreferrer"
          >
            <Logo className="service-logo" />
          </a>
        );
      })}
      {tmdbId && (
        <a
          aria-label="TMDB"
          href={`https://www.themoviedb.org/${mediaType}/${tmdbId}?language=${locale}`}
          className="external-link w-8"
          target="_blank"
          rel="noreferrer"
        >
          <TmdbLogo className="service-logo" />
        </a>
      )}
      {tvdbId && mediaType === MediaType.TV && (
        <a
          aria-label="TheTVDB"
          href={`http://www.thetvdb.com/?tab=series&id=${tvdbId}`}
          className="external-link w-9"
          target="_blank"
          rel="noreferrer"
        >
          <TvdbLogo className="service-logo" />
        </a>
      )}
      {imdbId && mediaType !== 'person' && (
        <a
          aria-label="IMDb"
          href={`https://www.imdb.com/title/${imdbId}`}
          className="external-link w-8"
          target="_blank"
          rel="noreferrer"
        >
          <ImdbLogo className="service-logo" />
        </a>
      )}
      {imdbId && mediaType === 'person' && (
        <a
          aria-label="IMDb"
          href={`https://www.imdb.com/name/${imdbId}`}
          className="external-link w-8"
          target="_blank"
          rel="noreferrer"
        >
          <ImdbLogo className="service-logo" />
        </a>
      )}
      {rtUrl && (
        <a
          aria-label="Rotten Tomatoes"
          href={rtUrl}
          className="external-link w-14"
          target="_blank"
          rel="noreferrer"
        >
          <RTLogo className="service-logo" />
        </a>
      )}
      {imdbId && mediaType !== 'person' && (
        <a
          aria-label="Trakt"
          href={`https://trakt.tv/${
            mediaType === 'movie' ? 'movies' : 'shows'
          }/${imdbId}`}
          className="external-link w-8"
          target="_blank"
          rel="noreferrer"
        >
          <TraktLogo className="service-logo" />
        </a>
      )}
      {imdbId && mediaType !== 'person' && (
        <a
          href={`https://api.simkl.com/redirect?to=Simkl&imdb=${encodeURIComponent(
            imdbId
          )}`}
          aria-label="Simkl"
          className="external-link w-8"
          target="_blank"
          rel="noreferrer"
        >
          <SimklLogo className="service-logo" />
        </a>
      )}
      {tmdbId && mediaType === MediaType.MOVIE && (
        <a
          aria-label="Letterboxd"
          href={`https://letterboxd.com/tmdb/${tmdbId}`}
          className="external-link w-8"
          target="_blank"
          rel="noreferrer"
        >
          <LetterboxdLogo className="service-logo" />
        </a>
      )}
    </div>
  );
};

export default ExternalLinkBlock;
