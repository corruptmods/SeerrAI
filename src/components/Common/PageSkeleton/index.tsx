import TitleCardPlaceholder from '@app/components/TitleCard/Placeholder';

/*
 * Loading placeholders that stand where the content will appear, in the same
 * layout, so a page fills in rather than jumping from a spinner. They reuse
 * the app's own shapes — the poster placeholder, the request card's loading
 * block, the page's slider and media-header classes — so they match what
 * replaces them.
 *
 * Class names are written out in full rather than assembled at runtime;
 * assembled names are stripped from the production stylesheet.
 */

const Bar = ({ className }: { className: string }) => (
  <div className={`animate-pulse rounded-md bg-gray-700 ${className}`} />
);

/** The home page: rows of sliders, each a title over a strip of posters. */
export const SliderRowsSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div aria-busy="true" aria-live="polite">
    {Array.from({ length: rows }, (_, row) => (
      <div key={`slider-skeleton-${row}`}>
        <div className="slider-header">
          <Bar className="h-7 w-44 sm:h-9 sm:w-56" />
        </div>
        <div className="flex space-x-4 overflow-hidden">
          {Array.from({ length: 8 }, (_, card) => (
            <div key={`slider-skeleton-${row}-${card}`} className="flex-none">
              <TitleCardPlaceholder />
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

/** A movie or series page: poster, title and buttons, then the overview. */
export const MediaPageSkeleton = () => (
  <div className="media-page" aria-busy="true" aria-live="polite">
    <div className="media-header">
      <div className="media-poster">
        <div
          className="w-full animate-pulse bg-gray-700"
          style={{ paddingBottom: '150%' }}
        />
      </div>
      <div className="media-title w-full items-center 2xl:items-start">
        <Bar className="mb-3 h-8 w-3/4 max-w-md sm:h-10" />
        <Bar className="h-5 w-1/2 max-w-xs" />
      </div>
      <div className="media-actions">
        <Bar className="h-10 w-10" />
        <Bar className="h-10 w-32" />
        <Bar className="h-10 w-28" />
      </div>
    </div>
    <div className="media-overview">
      <div className="flex-1 space-y-3">
        <Bar className="mb-2 h-7 w-40" />
        <Bar className="h-4 w-full" />
        <Bar className="h-4 w-full" />
        <Bar className="h-4 w-11/12" />
        <Bar className="h-4 w-2/3" />
      </div>
    </div>
  </div>
);

/** Requests and issues: a page heading over a column of cards. */
export const CardListSkeleton = ({ cards = 6 }: { cards?: number }) => (
  <div aria-busy="true" aria-live="polite">
    <div className="mb-4 mt-1 flex flex-col justify-between lg:flex-row lg:items-end">
      <Bar className="h-9 w-40" />
      <Bar className="mt-2 h-10 w-full lg:mt-0 lg:w-96" />
    </div>
    {Array.from({ length: cards }, (_, card) => (
      <div
        key={`card-skeleton-${card}`}
        className="mb-4 h-64 w-full animate-pulse rounded-xl bg-gray-800 xl:h-28"
      />
    ))}
  </div>
);

/** The watch lists page: a grid of list cards. */
export const ListCardsSkeleton = ({ cards = 6 }: { cards?: number }) => (
  <div aria-busy="true" aria-live="polite">
    <div className="mb-4 mt-1 flex items-end justify-between">
      <Bar className="h-9 w-40" />
      <Bar className="h-10 w-28" />
    </div>
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: cards }, (_, card) => (
        <li key={`list-card-skeleton-${card}`}>
          <div className="aspect-[16/10] animate-pulse rounded-xl border border-gray-700 bg-gray-800" />
        </li>
      ))}
    </ul>
  </div>
);

/** One watch list: its heading over a grid of posters. */
export const PosterGridSkeleton = ({ cards = 12 }: { cards?: number }) => (
  <div aria-busy="true" aria-live="polite">
    <div className="mb-6 mt-1">
      <Bar className="h-9 w-56" />
    </div>
    <ul className="cards-vertical">
      {Array.from({ length: cards }, (_, card) => (
        <li key={`poster-skeleton-${card}`}>
          <TitleCardPlaceholder canExpand />
        </li>
      ))}
    </ul>
  </div>
);
