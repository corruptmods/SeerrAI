import defineMessages from '@app/utils/defineMessages';
import { CalendarDaysIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal.FollowNewSeasons', {
  title: 'New seasons',
  label: 'Also get new seasons as they’re announced',
  hint: 'Requests each new season as soon as it’s announced.',
});

interface FollowNewSeasonsProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Series request option to request each future season once announced. */
const FollowNewSeasons = ({ checked, onChange }: FollowNewSeasonsProps) => {
  const intl = useIntl();

  return (
    <div className="mt-4 border-t border-gray-700 pt-4">
      <div className="mb-2 flex items-center space-x-2 text-sm font-semibold text-gray-300">
        <CalendarDaysIcon className="h-4 w-4" />
        <span>{intl.formatMessage(messages.title)}</span>
      </div>
      <label className="flex items-start space-x-2 text-sm text-gray-200">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 flex-none rounded border-gray-600 bg-gray-700 text-indigo-600"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {intl.formatMessage(messages.label)}
          <span className="block text-xs text-gray-400">
            {intl.formatMessage(messages.hint)}
          </span>
        </span>
      </label>
    </div>
  );
};

export default FollowNewSeasons;
