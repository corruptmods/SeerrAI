import defineMessages from '@app/utils/defineMessages';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsAi.ModelPicker', {
  another: 'Another model…',
  typeName: 'Model name',
  loading: 'Loading models…',
});

export interface ModelInfo {
  id: string;
  name: string;
}

const OTHER = '__other__';

/**
 * A model from the list the key can use, or any other by name. Before the
 * list has loaded, or when there is none, a name can still be typed.
 */
const ModelPicker = ({
  id,
  value,
  onChange,
  models,
  loading,
  emptyLabel,
}: {
  id: string;
  value: string;
  onChange: (model: string) => void;
  models: ModelInfo[];
  loading: boolean;
  /** The first choice: no model picked, or "same as the default". */
  emptyLabel: string;
}) => {
  const intl = useIntl();
  const listed = models.some((m) => m.id === value);
  const [typing, setTyping] = useState(false);
  const other = typing || (!!value && !listed);

  if (!models.length) {
    return (
      <input
        id={id}
        type="text"
        autoComplete="off"
        placeholder={
          loading ? intl.formatMessage(messages.loading) : emptyLabel
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="w-full space-y-2">
      <select
        id={id}
        value={other ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{emptyLabel}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name !== m.id ? `${m.name} (${m.id})` : m.id}
          </option>
        ))}
        <option value={OTHER}>{intl.formatMessage(messages.another)}</option>
      </select>
      {other && (
        <input
          type="text"
          autoComplete="off"
          aria-label={intl.formatMessage(messages.typeName)}
          placeholder={intl.formatMessage(messages.typeName)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
};

export default ModelPicker;
