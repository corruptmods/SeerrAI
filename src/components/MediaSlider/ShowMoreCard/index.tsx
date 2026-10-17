import CachedImage from '@app/components/Common/CachedImage';
import TitleCard from '@app/components/TitleCard';
import useNearScreen from '@app/hooks/useNearScreen';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/solid';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaSlider.ShowMoreCard', {
  seemore: 'See More',
});

interface ShowMoreCardProps {
  url: string;
  posters: (string | undefined)[];
}

const ShowMoreCard = ({ url, posters }: ShowMoreCardProps) => {
  const intl = useIntl();
  const [isHovered, setHovered] = useState(false);
  // Drawn, posters and all, as it nears the screen along the row.
  const { ref, near } = useNearScreen();

  if (!near) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder />
      </div>
    );
  }

  return (
    <Link
      href={url}
      className={'w-36 sm:w-36 md:w-44'}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setHovered(true);
        }
      }}
      role="link"
      tabIndex={0}
    >
      <div
        className={`relative w-36 transform-gpu cursor-pointer overflow-hidden rounded-xl text-strong shadow-lg ring-1 transition duration-150 ease-in-out sm:w-36 md:w-44 ${
          isHovered
            ? 'scale-105 bg-gray-600 ring-gray-500'
            : 'scale-100 bg-surface ring-subtle'
        }`}
      >
        <div style={{ paddingBottom: '150%' }}>
          <div className="absolute inset-0 flex h-full w-full flex-col items-center p-2">
            <div className="relative z-10 grid h-full w-full grid-cols-2 items-center justify-center gap-2 opacity-30">
              {posters[0] && (
                <div className="">
                  <CachedImage
                    type="tmdb"
                    src={`https://image.tmdb.org/t/p/w300_and_h450_face${posters[0]}`}
                    alt=""
                    className="rounded-md"
                    width={300}
                    height={450}
                  />
                </div>
              )}
              {posters[1] && (
                <div className="">
                  <CachedImage
                    type="tmdb"
                    src={`https://image.tmdb.org/t/p/w300_and_h450_face${posters[1]}`}
                    alt=""
                    className="rounded-md"
                    width={300}
                    height={450}
                  />
                </div>
              )}
              {posters[2] && (
                <div className="">
                  <CachedImage
                    type="tmdb"
                    src={`https://image.tmdb.org/t/p/w300_and_h450_face${posters[2]}`}
                    alt=""
                    className="rounded-md"
                    width={300}
                    height={450}
                  />
                </div>
              )}
              {posters[3] && (
                <div className="">
                  <CachedImage
                    type="tmdb"
                    src={`https://image.tmdb.org/t/p/w300_and_h450_face${posters[3]}`}
                    alt=""
                    className="rounded-md"
                    width={300}
                    height={450}
                  />
                </div>
              )}
            </div>
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-strong">
              <ArrowRightCircleIcon className="w-14" />
              <div className="mt-2 font-extrabold">
                {intl.formatMessage(messages.seemore)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
};

export default ShowMoreCard;
