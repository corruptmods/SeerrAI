import { countries } from 'country-flag-icons';

interface FlagProps {
  /** ISO 3166-1 code, such as US or GB. */
  code?: string | null;
  className?: string;
}

/** Whether there is a flag for the code. */
export const hasFlag = (code?: string | null): code is string =>
  !!code && countries.includes(code);

/**
 * A country's flag at the size of the text around it, fetched on its own
 * and only once it is near the screen. Decorative: the country is always
 * named beside it.
 */
const Flag = ({ code, className = '' }: FlagProps) => {
  if (!hasFlag(code)) {
    return null;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt=""
      aria-hidden="true"
      className={`inline-block h-[1em] w-[1.5em] object-cover ${className}`}
      decoding="async"
      height={2}
      loading="lazy"
      src={`/flags/${code}.svg`}
      width={3}
    />
  );
};

export default Flag;
