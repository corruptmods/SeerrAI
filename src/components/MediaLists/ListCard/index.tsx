import PosterBackground from '@app/components/Common/PosterBackground';
import MusicImage from '@app/components/Music/MusicImage';
import { albumCoverUrl } from '@app/components/Music/musicHelpers';
import {
  CROSSFADE_SECONDS,
  LIST_POSTER_SIZE,
  SECONDS_PER_POSTER,
  TILE_COUNT,
} from '@app/constants/lists';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  BookmarkIcon,
  MusicalNoteIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaLists.ListCard', {
  itemcount: '{count} {count, plural, one {title} other {titles}}',
  songcount: '{count} {count, plural, one {song} other {songs}}',
  sharedby: 'Shared by {name}',
  sharedwith:
    'Shared with {count} {count, plural, one {person} other {people}}',
  private: 'Private',
  emptylist: 'Empty',
  watchedcount: '{watched} of {count} watched',
});

interface Preview {
  tmdbId: number;
  posterPath?: string | null;
}

interface ListCardProps {
  id: number;
  name: string;
  watchedCount?: number;
  owner: { id: number; displayName: string };
  isOwner: boolean;
  itemCount: number;
  memberCount: number;
  previews: Preview[];
  /** A watch list, or a playlist (shown by its album covers). */
  kind?: 'watch' | 'music';
  /** A playlist's album covers, by release-group id. */
  covers?: string[];
  /** Offsets this card's animation so a grid of cards is not in lockstep. */
  index: number;
}

/** A fraction from 0 to 1, the same for the same seed on every render. */
const fraction = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** The posters in an order the seed sets, the same on every render. */
const mixed = <T,>(items: T[], seed: number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(fraction(seed + i * 0.618) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * One tile of a card's mosaic. It opens on a picture already in place, part
 * way through its time, so a page of cards looks as if it had been running
 * a while: no fade in on arrival, and tiles turning over at their own
 * moments rather than together. Each new picture fades in over the one
 * before, which stays put underneath until it is covered. A watch list's
 * tiles show posters, a playlist's album covers.
 */
const RotatingTile = <T,>({
  items,
  seed,
  slide,
}: {
  items: T[];
  seed: number;
  /** One picture of the tile, drawn with the class and style given. */
  slide: (
    item: T,
    className: string,
    style: React.CSSProperties,
    key: number
  ) => React.ReactNode;
}) => {
  const count = items.length;
  // Where this tile starts in its pictures, and how far into the first
  // one's time it already is.
  const first = Math.floor(fraction(seed) * count);
  const phase = fraction(seed + 0.5);
  // The picture shown and the one under it, by how many turns in each is.
  const [shown, setShown] = useState([0]);

  useEffect(() => {
    if (count < 2) {
      return;
    }
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      return;
    }
    const advance = () =>
      setShown((now) => {
        const last = now[now.length - 1];
        return [last, last + 1];
      });
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(
      () => {
        advance();
        timer = setInterval(advance, SECONDS_PER_POSTER * 1000);
      },
      (1 - phase) * SECONDS_PER_POSTER * 1000
    );
    return () => {
      clearTimeout(start);
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [count, phase]);

  return (
    <div className="list-mosaic-tile">
      {shown.map((step) =>
        slide(
          items[(first + step) % count],
          // Every picture after the first fades in; the class never changes
          // on one once shown, so its drift is never restarted.
          step > 0 ? 'list-poster-slide entering' : 'list-poster-slide',
          {
            animationDuration: `${CROSSFADE_SECONDS}s, ${
              SECONDS_PER_POSTER + CROSSFADE_SECONDS
            }s`,
            // The first picture is part way through its slow drift already.
            animationDelay:
              step === 0
                ? `0s, -${(phase * SECONDS_PER_POSTER).toFixed(2)}s`
                : '0s, 0s',
          },
          step
        )
      )}
    </div>
  );
};

/** Each tile's own share of the pictures, so no two tiles show the same one. */
const shares = <T,>(items: T[]): T[][] => {
  const tileCount = Math.min(items.length, TILE_COUNT);
  return Array.from({ length: tileCount }, (_, tile) =>
    items.filter((_, i) => i % tileCount === tile)
  );
};

const ListCard = ({
  id,
  name,
  owner,
  isOwner,
  itemCount,
  watchedCount = 0,
  memberCount,
  previews,
  kind = 'watch',
  covers = [],
  index,
}: ListCardProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const playlist = kind === 'music';
  // A new start each visit: which pictures each tile shows, and where in
  // them it begins. The same while the page stays open.
  const [visit] = useState(() => Math.floor(Math.random() * 1_000_000));
  // Each tile walks its own share, starting at a different place in it.
  const posterTiles = shares(
    mixed(
      previews.filter((p) => p.posterPath),
      visit + index
    )
  );
  const coverTiles = shares(mixed(covers, visit + index));

  return (
    <Link
      className="group relative block aspect-[16/10] overflow-hidden rounded-xl border border-subtle bg-surface shadow transition duration-200 hover:border-gray-500 hover:shadow-lg"
      href={`/lists/${id}`}
    >
      {playlist && coverTiles.length > 0 ? (
        <div
          className="list-mosaic"
          style={{ '--list-tiles': coverTiles.length } as React.CSSProperties}
        >
          {coverTiles.map((tileCovers, tileIndex) => (
            <RotatingTile
              key={`tile-${tileIndex}`}
              items={tileCovers}
              seed={visit + index * TILE_COUNT + tileIndex}
              slide={(albumMbid, className, style, key) => (
                <div key={key} className={className} style={style}>
                  <MusicImage
                    src={albumCoverUrl(
                      albumMbid,
                      !!currentSettings.cacheImages
                    )}
                    fallback="album"
                    sizes="12rem"
                  />
                </div>
              )}
            />
          ))}
        </div>
      ) : playlist ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <MusicalNoteIcon className="h-10 w-10 text-gray-600" />
        </div>
      ) : posterTiles.length > 0 ? (
        <div
          className="list-mosaic"
          style={{ '--list-tiles': posterTiles.length } as React.CSSProperties}
        >
          {posterTiles.map((tilePosters, tileIndex) => (
            <RotatingTile
              key={`tile-${tileIndex}`}
              items={tilePosters}
              seed={visit + index * TILE_COUNT + tileIndex}
              slide={(poster, className, style, key) => (
                <PosterBackground
                  key={key}
                  className={className}
                  posterPath={poster.posterPath}
                  size={LIST_POSTER_SIZE}
                  style={style}
                />
              )}
            />
          ))}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <BookmarkIcon className="h-10 w-10 text-gray-600" />
        </div>
      )}

      <div className="list-card-gradient absolute inset-0" />

      <div className="absolute inset-x-0 bottom-0 p-4">
        <h3 className="break-words text-lg font-bold text-on-media drop-shadow">
          {name}
        </h3>
        <div className="mt-1 flex items-center space-x-3 text-xs text-gray-300 light:text-on-media/80">
          <span>
            {!itemCount
              ? intl.formatMessage(messages.emptylist)
              : playlist
                ? intl.formatMessage(messages.songcount, { count: itemCount })
                : watchedCount
                  ? intl.formatMessage(messages.watchedcount, {
                      watched: watchedCount,
                      count: itemCount,
                    })
                  : intl.formatMessage(messages.itemcount, {
                      count: itemCount,
                    })}
          </span>
          <span className="flex items-center space-x-1">
            <UsersIcon className="h-3.5 w-3.5" />
            <span>
              {isOwner
                ? memberCount
                  ? intl.formatMessage(messages.sharedwith, {
                      count: memberCount,
                    })
                  : intl.formatMessage(messages.private)
                : intl.formatMessage(messages.sharedby, {
                    name: owner.displayName,
                  })}
            </span>
          </span>
        </div>
      </div>
    </Link>
  );
};

export default ListCard;
