import type { NotificationItem } from '@app/components/NotificationTypeSelector';
import { hasNotificationType } from '@app/components/NotificationTypeSelector';

interface NotificationTypeProps {
  option: NotificationItem;
  currentTypes: number;
  parent?: NotificationItem;
  onUpdate: (newTypes: number) => void;
  /** Said under a type the admin turned off for everyone. */
  turnedOffNote?: string;
}

const NotificationType = ({
  option,
  currentTypes,
  onUpdate,
  parent,
  turnedOffNote,
}: NotificationTypeProps) => {
  const parentOn =
    !!parent?.value && hasNotificationType(parent.value, currentTypes);
  const off = !!option.turnedOff;
  return (
    <>
      <div
        className={`relative mt-4 flex items-start first:mt-0 ${
          parentOn || off ? 'opacity-50' : ''
        }`}
      >
        <div className="flex h-6 items-center">
          <input
            id={option.id}
            name="permissions"
            type="checkbox"
            disabled={parentOn || off}
            onClick={() => {
              onUpdate(
                hasNotificationType(option.value, currentTypes)
                  ? currentTypes - option.value
                  : currentTypes + option.value
              );
            }}
            checked={
              !off &&
              (hasNotificationType(option.value, currentTypes) || parentOn)
            }
          />
        </div>
        <div className="ml-3 text-sm leading-6">
          <label htmlFor={option.id} className="block" aria-label={option.name}>
            <div className="flex flex-col">
              <span className="font-medium text-strong">{option.name}</span>
              <span className="font-normal text-gray-400">
                {option.description}
              </span>
              {off && turnedOffNote && (
                <span className="font-normal italic text-gray-400">
                  {turnedOffNote}
                </span>
              )}
            </div>
          </label>
        </div>
      </div>
      {(option.children ?? []).map((child) => (
        <div key={`notification-type-child-${child.id}`} className="mt-4 pl-6">
          <NotificationType
            option={child}
            currentTypes={currentTypes}
            onUpdate={(newTypes) => onUpdate(newTypes)}
            parent={option}
            turnedOffNote={turnedOffNote}
          />
        </div>
      ))}
    </>
  );
};

export default NotificationType;
