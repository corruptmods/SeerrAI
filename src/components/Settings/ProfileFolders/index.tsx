import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/solid';
import type { ProfileFolder } from '@server/constants/requestDefaults';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.ProfileFolders', {
  profileFolders: 'Folders by Quality Profile',
  profileFoldersTip:
    'A request with one of these profiles goes to its folder, over override rules. Only request managers can pick another',
  qualityProfile: 'Quality Profile',
  rootFolder: 'Root Folder',
  add: 'Add Profile',
  remove: 'Remove',
});

interface ProfileFoldersProps {
  profiles: { id: number; name: string }[];
  rootFolders: { id: number; path: string }[];
  value: ProfileFolder[];
  onChange: (value: ProfileFolder[]) => void;
  disabled?: boolean;
}

/** Root folders some quality profiles always go to, for one server. */
const ProfileFolders = ({
  profiles,
  rootFolders,
  value,
  onChange,
  disabled,
}: ProfileFoldersProps) => {
  const intl = useIntl();
  const unused = profiles.filter(
    (profile) => !value.some((entry) => entry.profileId === profile.id)
  );
  const set = (index: number, change: Partial<ProfileFolder>) =>
    onChange(
      value.map((entry, i) => (i === index ? { ...entry, ...change } : entry))
    );

  return (
    <div className="form-row">
      <span id="profile-folders-label" className="text-label">
        {intl.formatMessage(messages.profileFolders)}
        <span className="label-tip">
          {intl.formatMessage(messages.profileFoldersTip)}
        </span>
      </span>
      <div
        className="form-input-area"
        role="group"
        aria-labelledby="profile-folders-label"
      >
        {value.map((entry, index) => (
          <div
            key={`${entry.profileId}-${index}`}
            className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <select
              aria-label={intl.formatMessage(messages.qualityProfile)}
              value={entry.profileId}
              disabled={disabled}
              onChange={(e) =>
                set(index, { profileId: Number(e.target.value) })
              }
            >
              {profiles
                .filter(
                  (profile) =>
                    profile.id === entry.profileId ||
                    !value.some((other) => other.profileId === profile.id)
                )
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              {!profiles.some((profile) => profile.id === entry.profileId) && (
                <option value={entry.profileId}>{entry.profileId}</option>
              )}
            </select>
            <select
              aria-label={intl.formatMessage(messages.rootFolder)}
              value={entry.rootFolder}
              disabled={disabled}
              onChange={(e) => set(index, { rootFolder: e.target.value })}
            >
              {rootFolders.map((folder) => (
                <option key={folder.id} value={folder.path}>
                  {folder.path}
                </option>
              ))}
              {!rootFolders.some(
                (folder) => folder.path === entry.rootFolder
              ) && <option value={entry.rootFolder}>{entry.rootFolder}</option>}
            </select>
            <Button
              buttonType="danger"
              buttonSize="sm"
              type="button"
              disabled={disabled}
              aria-label={intl.formatMessage(messages.remove)}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <TrashIcon />
            </Button>
          </div>
        ))}
        <Button
          buttonSize="sm"
          type="button"
          disabled={disabled || !unused.length || !rootFolders.length}
          onClick={() =>
            onChange([
              ...value,
              { profileId: unused[0].id, rootFolder: rootFolders[0].path },
            ])
          }
        >
          <PlusIcon />
          <span>{intl.formatMessage(messages.add)}</span>
        </Button>
      </div>
    </div>
  );
};

export default ProfileFolders;
