import CachedImage from '@app/components/Common/CachedImage';
import { mountedImages } from '@app/components/Common/ImageFader/mounted';
import type { ForwardRefRenderFunction, HTMLAttributes } from 'react';
import React, { useEffect, useState } from 'react';

interface ImageFaderProps extends HTMLAttributes<HTMLDivElement> {
  backgroundImages: string[];
  rotationSpeed?: number;
  isDarker?: boolean;
  forceOptimize?: boolean;
}

const DEFAULT_ROTATION_SPEED = 6000;

const ImageFader: ForwardRefRenderFunction<HTMLDivElement, ImageFaderProps> = (
  {
    backgroundImages,
    rotationSpeed = DEFAULT_ROTATION_SPEED,
    isDarker,
    forceOptimize,
    ...props
  },
  ref
) => {
  const [activeIndex, setIndex] = useState(0);
  const [rotated, setRotated] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((ai) => (ai + 1) % backgroundImages.length);
      setRotated(true);
    }, rotationSpeed);

    return () => {
      clearInterval(interval);
    };
  }, [backgroundImages, rotationSpeed]);

  // Both follow the look (globals.css): the darker one fades into the page
  // as a title page's backdrop does.
  let gradient =
    'linear-gradient(180deg, rgb(var(--backdrop-fade-from) / var(--backdrop-fade-start)) 0%, rgb(var(--backdrop-fade-to)) 100%)';

  if (isDarker) {
    gradient =
      'linear-gradient(180deg, rgb(var(--page) / var(--title-fade)) 0%, rgb(var(--page)) 100%)';
  }

  let overrides = {};

  if (forceOptimize) {
    overrides = {
      unoptimized: false,
    };
  }

  const mounted = mountedImages(activeIndex, backgroundImages.length, rotated);

  return (
    <div ref={ref}>
      {backgroundImages.map((imageUrl, i) =>
        !mounted.has(i) ? null : (
          <div
            key={`banner-image-${i}`}
            className={`absolute-top-shift absolute inset-0 bg-cover bg-center transition-opacity duration-300 ease-in ${
              i === activeIndex ? 'opacity-100' : 'opacity-0'
            }`}
            {...props}
          >
            <CachedImage
              type="tmdb"
              className="absolute inset-0 h-full w-full"
              alt=""
              src={imageUrl}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fill
              // The first is at the top of the page as it opens.
              priority={i === 0}
              {...overrides}
            />
            <div
              className="absolute inset-0"
              style={{ backgroundImage: gradient }}
            />
          </div>
        )
      )}
    </div>
  );
};

export default React.forwardRef<HTMLDivElement, ImageFaderProps>(ImageFader);
