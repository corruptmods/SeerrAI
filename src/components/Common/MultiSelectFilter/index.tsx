import useClickOutside from '@app/hooks/useClickOutside';
import defineMessages from '@app/utils/defineMessages';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.MultiSelectFilter', {
  all: 'All',
  selectedcount: '{count} selected',
});

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  /** Leading icon, matching the bordered square on the single selects. */
  icon: React.ReactNode;
  options: MultiSelectOption[];
  /** Empty means no filtering — shown as "All". */
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Label used when nothing is ticked. */
  allLabel?: string;
  name: string;
}

/**
 * A drop-down that ticks several values at once, styled to sit beside the
 * plain selects on the request list: same bordered icon, same control height,
 * same rounded-right body.
 */
const MultiSelectFilter = ({
  icon,
  options,
  selected,
  onChange,
  allLabel,
  name,
}: MultiSelectFilterProps) => {
  const intl = useIntl();
  const [isOpen, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setOpen(false));

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value]
    );
  };

  const summary = !selected.length
    ? (allLabel ?? intl.formatMessage(messages.all))
    : selected.length === 1
      ? (options.find((option) => option.value === selected[0])?.label ??
        intl.formatMessage(messages.selectedcount, { count: 1 }))
      : intl.formatMessage(messages.selectedcount, { count: selected.length });

  return (
    <div className="relative flex" ref={containerRef}>
      <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
        {icon}
      </span>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="flex h-10 w-full min-w-0 items-center justify-between rounded-r-md border border-gray-500 bg-gray-700 px-3 text-left text-sm text-white transition hover:bg-gray-600 focus:border-blue-500 focus:outline-none"
        id={name}
        onClick={() => setOpen((open) => !open)}
        type="button"
      >
        <span className="truncate">{summary}</span>
        <ChevronDownIcon className="ml-2 h-4 w-4 flex-none text-gray-300" />
      </button>

      {isOpen && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-gray-600 bg-gray-800 p-1 shadow-lg"
          role="listbox"
        >
          {options.map((option) => (
            <label
              className="flex cursor-pointer items-center space-x-2 rounded px-2 py-2 text-sm text-gray-200 hover:bg-gray-700"
              key={`${name}-${option.value}`}
            >
              <input
                checked={selected.includes(option.value)}
                className="h-4 w-4 flex-none rounded border-gray-600 bg-gray-700 text-indigo-600"
                onChange={() => toggle(option.value)}
                type="checkbox"
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

export default MultiSelectFilter;
