import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';

interface PageSearchProps {
  name: string;
  value: string;
  onChange: (value: string) => void;
  /** What the field is for, read out in full by screen readers. */
  label: string;
  /** A hint short enough to fit beside a button on a phone. */
  placeholder: string;
  clearLabel: string;
}

/**
 * A page's own search field: the filter over a list of films or series,
 * the Music page's search. They look and behave alike.
 */
const PageSearch = ({
  name,
  value,
  onChange,
  label,
  placeholder,
  clearLabel,
}: PageSearchProps) => (
  <div className="relative flex flex-1">
    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
      <MagnifyingGlassIcon className="h-5 w-5" />
    </span>
    <input
      type="text"
      inputMode="search"
      enterKeyHint="search"
      name={name}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      maxLength={100}
      onChange={(e) => onChange(e.target.value)}
      // Room for the clear button only while there is something to clear,
      // so the hint fits beside Select on a phone.
      className={`rounded-r-only text-ellipsis ${value ? 'pr-9' : ''}`}
    />
    {value && (
      <button
        type="button"
        aria-label={clearLabel}
        onClick={() => onChange('')}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-strong"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
    )}
  </div>
);

export default PageSearch;
