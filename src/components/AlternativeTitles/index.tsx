import Flag from '@app/components/Common/Flag';
import useLocale from '@app/hooks/useLocale';
import defineMessages from '@app/utils/defineMessages';
import type { AlternativeTitle } from '@server/models/common';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.AlternativeTitles', {
  alsoKnownAs: 'Also Known As',
  showMore: 'Show {count} More',
  showLess: 'Show Less',
});

/** Titles shown before Show More. */
const FIRST = 3;

/**
 * A title page's other names from TMDB, each with where it's used. Hidden
 * when there are none.
 */
const AlternativeTitles = ({ titles }: { titles?: AlternativeTitle[] }) => {
  const intl = useIntl();
  const { locale } = useLocale();
  const [showAll, setShowAll] = useState(false);
  const regionName = useMemo(() => {
    try {
      const names = new Intl.DisplayNames([locale], { type: 'region' });
      return (code: string) => names.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [locale]);

  if (!titles?.length) {
    return null;
  }
  const shown = showAll ? titles : titles.slice(0, FIRST);

  return (
    <div className="media-fact">
      <span>{intl.formatMessage(messages.alsoKnownAs)}</span>
      <span className="media-fact-value">
        <ul className="space-y-1">
          {shown.map(({ title, countries }) => {
            const where = countries.map(regionName).join(', ');
            return (
              <li
                key={title}
                className="flex items-center justify-end gap-1.5"
                title={where || undefined}
              >
                <span className="break-words">{title}</span>
                {countries.slice(0, 3).map((code) => (
                  <Flag key={code} code={code} />
                ))}
                {where && <span className="sr-only">({where})</span>}
              </li>
            );
          })}
        </ul>
        {titles.length > FIRST && (
          <button
            type="button"
            className="mt-1"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll
              ? intl.formatMessage(messages.showLess)
              : intl.formatMessage(messages.showMore, {
                  count: titles.length - FIRST,
                })}
          </button>
        )}
      </span>
    </div>
  );
};

export default AlternativeTitles;
