import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SaveBar from '@app/components/Common/SaveBar';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import UserSeasons from '@app/components/Seasonal/UserSeasons';
import PersonalCss from '@app/components/Themes/PersonalCss';
import ThemeChoices from '@app/components/Themes/ThemeChoices';
import { useTheme } from '@app/context/ThemeContext';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { accentColours, deviceMode } from '@app/utils/theme';
import {
  ACCENTS,
  CUSTOM_ACCENT_START,
  DARK_BACKGROUNDS,
} from '@app/utils/theme/palette';
import {
  ArrowDownOnSquareIcon,
  ArrowUturnLeftIcon,
  ComputerDesktopIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
} from '@heroicons/react/24/outline';
import type {
  Appearance,
  ThemeAccent,
  ThemeBackground,
  ThemeCorners,
  ThemeDefaults,
  ThemeMode,
  ThemeSpacing,
} from '@server/constants/theme';
import {
  THEME_ACCENTS,
  THEME_BACKGROUNDS,
  appearanceFromDefaults,
  cleanHexColour,
} from '@server/constants/theme';
import axios from 'axios';
import { Form, Formik, useFormikContext } from 'formik';
import { useRouter } from 'next/router';
import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

export const appearanceMessages = defineMessages(
  'components.UserProfile.UserSettings.UserAppearanceSettings',
  {
    appearance: 'Appearance',
    description:
      'How Seerr AI looks for you, on every device. Nobody else’s screen changes.',
    mode: 'Mode',
    modeLight: 'Light',
    modeDark: 'Dark',
    modeAuto: 'Match my device',
    modeNoteLight: 'Light all the time.',
    modeNoteDark: 'Dark all the time.',
    modeNoteAutoDark: 'Following your device, which is dark right now.',
    modeNoteAutoLight: 'Following your device, which is light right now.',
    accent: 'Accent colour',
    accentDescription: 'Buttons, links, switches and highlights.',
    accentIndigo: 'Indigo',
    accentSeerr: 'Seerr AI',
    accentTeal: 'Teal',
    accentGreen: 'Green',
    accentRose: 'Rose',
    accentAmber: 'Amber',
    accentPlex: 'Plex',
    accentJellyfin: 'Jellyfin',
    accentCustom: 'Custom',
    customColour: 'Your colour',
    customColourHex: 'Your colour, as a hex code',
    customInkDark: 'Button text switched to dark so it stays readable.',
    validationColour: 'A colour such as #0ea5e9',
    background: 'Dark background',
    backgroundDescription: 'Used whenever Seerr AI is dark.',
    backgroundClassic: 'Classic',
    backgroundBlack: 'True black',
    backgroundSlate: 'Slate',
    backgroundWarm: 'Warm',
    extras: 'Extras',
    spacing: 'Spacing',
    spacingComfortable: 'Comfortable',
    spacingCompact: 'Compact',
    corners: 'Corners',
    cornersRounded: 'Rounded',
    cornersSquare: 'Square',
    blur: 'Blur behind title pages',
    blurHint: 'The softened backdrop behind a film or series.',
    solidPanels: 'Reduce see-through panels',
    solidPanelsHint: 'Solid panels instead. Easier on older phones.',
    useServerDefault: 'Use the Server’s Default',
    usingServerDefault:
      'You’re using the server’s default. Anything you change here is yours alone.',
    saved: 'Appearance saved.',
    reset: 'You’re back to the server’s default.',
    failed: 'Something went wrong while saving.',
    loadFailed: 'Your appearance settings could not be loaded.',
    preview: 'Preview',
    previewTitle: 'Night Harbour',
    previewDetails: '2025 · Drama · 2h 4m',
    previewNotify: 'Notify me when it’s ready',
    previewRequestedBy: 'Requested by {name}',
  }
);

const messages = appearanceMessages;

export const ACCENT_NAMES: Record<ThemeAccent, keyof typeof messages> = {
  indigo: 'accentIndigo',
  seerr: 'accentSeerr',
  teal: 'accentTeal',
  green: 'accentGreen',
  rose: 'accentRose',
  amber: 'accentAmber',
  plex: 'accentPlex',
  jellyfin: 'accentJellyfin',
  custom: 'accentCustom',
};

export const BACKGROUND_NAMES: Record<ThemeBackground, keyof typeof messages> =
  {
    classic: 'backgroundClassic',
    black: 'backgroundBlack',
    slate: 'backgroundSlate',
    warm: 'backgroundWarm',
  };

const MODES: {
  id: ThemeMode;
  name: keyof typeof messages;
  icon: React.ElementType;
}[] = [
  { id: 'light', name: 'modeLight', icon: SunIcon },
  { id: 'dark', name: 'modeDark', icon: MoonIcon },
  { id: 'auto', name: 'modeAuto', icon: ComputerDesktopIcon },
];

/** A colour as the form keeps it: a custom accent needs a valid colour. */
export const accentSchema = (message: string) =>
  Yup.string().when('accent', {
    is: 'custom',
    then: (schema) =>
      schema.test('colour', message, (value) => !!cleanHexColour(value)),
  });

/**
 * The picker for a custom accent: the browser's colour picker and the same
 * colour as a hex code, which can be typed or pasted. Used here and by the
 * server's default (Settings → Appearance).
 */
export const CustomAccentField = ({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) => {
  const intl = useIntl();
  const id = useId();
  const valid = cleanHexColour(value);
  const inkIsDark = valid
    ? accentColours({ accent: 'custom', customAccent: valid }).inkIsDark
    : false;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${id}-picker`} className="mb-0 text-strong">
          {intl.formatMessage(messages.customColour)}
        </label>
        <input
          id={`${id}-picker`}
          type="color"
          value={valid ?? CUSTOM_ACCENT_START}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-14 cursor-pointer rounded-md border border-field-border bg-field p-1"
        />
        <input
          type="text"
          aria-label={intl.formatMessage(messages.customColourHex)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="!w-32 !flex-none font-mono"
        />
      </div>
      {error ? (
        <div className="error mt-0">{error}</div>
      ) : (
        inkIsDark && (
          <p className="text-sm text-muted" aria-live="polite">
            {intl.formatMessage(messages.customInkDark)}
          </p>
        )
      )}
    </div>
  );
};

/** One of a row of buttons of which one is chosen. */
const Segmented = <T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; name: string }[];
  value: T;
  onChange: (value: T) => void;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <span className="font-medium text-strong">{label}</span>
    <div
      role="group"
      aria-label={label}
      className="flex rounded-md border border-subtle bg-surface p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded px-3.5 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
            value === option.id
              ? 'bg-accent text-on-accent'
              : 'text-strong hover:bg-surface-raised'
          }`}
        >
          {option.name}
        </button>
      ))}
    </div>
  </div>
);

/** A switch with a name and a line saying what it does. */
const Switch = ({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: () => void;
}) => (
  <div className="flex items-center justify-between gap-4">
    <div>
      <div className="font-medium text-strong">{label}</div>
      <div className="text-sm text-muted">{hint}</div>
    </div>
    <SlideCheckbox checked={checked} onClick={onChange} label={label} />
  </div>
);

/** How the chosen look comes out on a title, a few badges and a panel. */
const Preview = ({ name }: { name: string }) => {
  const intl = useIntl();
  return (
    <aside
      aria-label={intl.formatMessage(messages.preview)}
      className="flex flex-col gap-4"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
        {intl.formatMessage(messages.preview)}
      </h2>
      <div
        className="relative h-52 overflow-hidden rounded-xl bg-[#2b3a57]"
        aria-hidden="true"
      >
        <div
          className="absolute inset-0 scale-110"
          style={{
            background:
              'repeating-linear-gradient(135deg, #34476b 0 18px, #2b3a57 18px 36px)',
            filter: 'blur(var(--title-blur))',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 bg-media-scrim/80 p-4">
          <div className="h-24 w-16 flex-none rounded-md bg-[#5b6f99]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold text-on-media">
              {intl.formatMessage(messages.previewTitle)}
            </div>
            <div className="mb-2 text-sm text-on-media/80">
              {intl.formatMessage(messages.previewDetails)}
            </div>
            <Button
              type="button"
              buttonType="primary"
              buttonSize="sm"
              tabIndex={-1}
            >
              {intl.formatMessage(globalMessages.request)}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" aria-hidden="true">
        <Badge badgeType="success">
          {intl.formatMessage(globalMessages.available)}
        </Badge>
        <Badge>{intl.formatMessage(globalMessages.requested)}</Badge>
        <Badge badgeType="warning">
          {intl.formatMessage(globalMessages.pending)}
        </Badge>
      </div>
      <div
        className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface/panel p-4"
        aria-hidden="true"
      >
        <div className="flex items-center justify-between text-sm text-strong">
          <span>{intl.formatMessage(messages.previewNotify)}</span>
          <SlideCheckbox checked onClick={() => undefined} />
        </div>
        <div className="text-sm text-muted">
          {intl.formatMessage(messages.previewRequestedBy, {
            name: (
              <span className="font-semibold text-accent-text">{name}</span>
            ),
          })}
        </div>
      </div>
    </aside>
  );
};

/** The form's sections; changes show at once while editing one's own. */
const AppearanceFields = ({
  preview,
  isOwn,
  onReset,
  resetting,
}: {
  preview: (appearance: Appearance | null) => void;
  isOwn: boolean;
  onReset: () => void;
  resetting: boolean;
}) => {
  const intl = useIntl();
  const { values, setFieldValue, errors, isSubmitting } =
    useFormikContext<Appearance>();
  const { user } = useUser();

  // Shown on screen as it is chosen, and taken back on leaving unsaved.
  const shown = JSON.stringify(values);
  useEffect(() => {
    if (!isOwn) {
      return;
    }
    const look = JSON.parse(shown) as Appearance;
    if (look.accent !== 'custom' || cleanHexColour(look.customAccent)) {
      preview({ ...look, customAccent: cleanHexColour(look.customAccent) });
    }
  }, [shown, isOwn, preview]);
  useEffect(() => () => preview(null), [preview]);

  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) =>
    setFieldValue(key, value);

  // What "Match my device" shows, kept up to date as the device changes.
  const [device, setDevice] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: light)');
    const update = () => setDevice(deviceMode());
    update();
    query?.addEventListener('change', update);
    return () => query?.removeEventListener('change', update);
  }, []);

  const modeNote =
    values.mode === 'light'
      ? messages.modeNoteLight
      : values.mode === 'dark'
        ? messages.modeNoteDark
        : device === 'light'
          ? messages.modeNoteAutoLight
          : messages.modeNoteAutoDark;

  return (
    <div className="flex flex-col gap-10 xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-10">
        <section
          aria-labelledby="appearance-mode"
          className="flex flex-col gap-3"
        >
          <h2
            id="appearance-mode"
            className="text-lg font-semibold text-strong"
          >
            {intl.formatMessage(messages.mode)}
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {MODES.map(({ id, name, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={values.mode === id}
                onClick={() => set('mode', id)}
                className={`flex flex-col items-center gap-2 rounded-xl border-2 px-2 py-4 text-sm font-semibold text-strong transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  values.mode === id
                    ? 'border-accent bg-accent-soft/20'
                    : 'border-subtle bg-surface hover:border-strong'
                }`}
              >
                <Icon className="h-7 w-7" aria-hidden="true" />
                {intl.formatMessage(messages[name])}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">{intl.formatMessage(modeNote)}</p>
        </section>

        <section
          aria-labelledby="appearance-accent"
          className="flex flex-col gap-3"
        >
          <h2
            id="appearance-accent"
            className="text-lg font-semibold text-strong"
          >
            {intl.formatMessage(messages.accent)}
          </h2>
          <p className="text-sm text-muted">
            {intl.formatMessage(messages.accentDescription)}
          </p>
          <div className="flex flex-wrap gap-x-2.5 gap-y-3.5">
            {THEME_ACCENTS.map((accent) => {
              const chosen = values.accent === accent;
              const isCustom = accent === 'custom';
              const fill = isCustom
                ? (cleanHexColour(values.customAccent) ?? CUSTOM_ACCENT_START)
                : ACCENTS[accent].fill;
              return (
                <button
                  key={accent}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => {
                    set('accent', accent);
                    if (isCustom && !values.customAccent) {
                      set('customAccent', CUSTOM_ACCENT_START);
                    }
                  }}
                  className="group flex w-20 flex-col items-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-11 w-11 items-center justify-center rounded-full ring-offset-4 ring-offset-page transition ${
                      chosen
                        ? 'ring-2 ring-gray-100'
                        : 'group-hover:ring-2 group-hover:ring-subtle'
                    } ${isCustom && !chosen ? 'border-2 border-dashed border-strong text-muted' : ''}`}
                    style={
                      isCustom && !chosen
                        ? undefined
                        : { backgroundColor: fill }
                    }
                  >
                    {isCustom && !chosen && <PlusIcon className="h-5 w-5" />}
                  </span>
                  {intl.formatMessage(messages[ACCENT_NAMES[accent]])}
                </button>
              );
            })}
          </div>
          {values.accent === 'custom' && (
            <CustomAccentField
              value={values.customAccent ?? ''}
              error={errors.customAccent}
              onChange={(value) => set('customAccent', value)}
            />
          )}
        </section>

        <section
          aria-labelledby="appearance-background"
          className="flex flex-col gap-3"
        >
          <h2
            id="appearance-background"
            className="text-lg font-semibold text-strong"
          >
            {intl.formatMessage(messages.background)}
          </h2>
          <p className="text-sm text-muted">
            {intl.formatMessage(messages.backgroundDescription)}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {THEME_BACKGROUNDS.map((background) => {
              const n = DARK_BACKGROUNDS[background];
              return (
                <button
                  key={background}
                  type="button"
                  aria-pressed={values.background === background}
                  onClick={() => set('background', background)}
                  className={`flex flex-col gap-2.5 rounded-xl border-2 bg-surface p-2.5 text-left text-sm font-semibold text-strong transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    values.background === background
                      ? 'border-accent'
                      : 'border-subtle hover:border-strong'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-16 w-full gap-1.5 rounded-md p-2"
                    style={{ backgroundColor: n.page }}
                  >
                    <span
                      className="w-1/5 rounded-sm"
                      style={{ backgroundColor: n.sidebar }}
                    />
                    <span className="flex flex-1 flex-col gap-1">
                      <span
                        className="h-2.5 rounded-sm"
                        style={{ backgroundColor: n.surfaceRaised }}
                      />
                      <span
                        className="flex-1 rounded-sm"
                        style={{ backgroundColor: n.surface }}
                      />
                    </span>
                  </span>
                  {intl.formatMessage(messages[BACKGROUND_NAMES[background]])}
                </button>
              );
            })}
          </div>
        </section>

        <UserSeasons
          seasonal={values.seasonal}
          onToggle={() => set('seasonal', !values.seasonal)}
          isOwn={isOwn}
        />

        <section
          aria-labelledby="appearance-extras"
          className="flex flex-col gap-4"
        >
          <h2
            id="appearance-extras"
            className="text-lg font-semibold text-strong"
          >
            {intl.formatMessage(messages.extras)}
          </h2>
          <Segmented<ThemeSpacing>
            label={intl.formatMessage(messages.spacing)}
            value={values.spacing}
            onChange={(value) => set('spacing', value)}
            options={[
              {
                id: 'comfortable',
                name: intl.formatMessage(messages.spacingComfortable),
              },
              {
                id: 'compact',
                name: intl.formatMessage(messages.spacingCompact),
              },
            ]}
          />
          <Segmented<ThemeCorners>
            label={intl.formatMessage(messages.corners)}
            value={values.corners}
            onChange={(value) => set('corners', value)}
            options={[
              {
                id: 'rounded',
                name: intl.formatMessage(messages.cornersRounded),
              },
              {
                id: 'square',
                name: intl.formatMessage(messages.cornersSquare),
              },
            ]}
          />
          <Switch
            label={intl.formatMessage(messages.blur)}
            hint={intl.formatMessage(messages.blurHint)}
            checked={values.blur}
            onChange={() => set('blur', !values.blur)}
          />
          <Switch
            label={intl.formatMessage(messages.solidPanels)}
            hint={intl.formatMessage(messages.solidPanelsHint)}
            checked={values.solidPanels}
            onChange={() => set('solidPanels', !values.solidPanels)}
          />
        </section>

        <ThemeChoices isOwn={isOwn} />

        <SaveBar>
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              onClick={onReset}
              disabled={isSubmitting || resetting}
            >
              <ArrowUturnLeftIcon />
              <span>{intl.formatMessage(messages.useServerDefault)}</span>
            </Button>
            <Button
              buttonType="primary"
              type="submit"
              disabled={isSubmitting || resetting}
            >
              <ArrowDownOnSquareIcon />
              <span>
                {isSubmitting
                  ? intl.formatMessage(globalMessages.saving)
                  : intl.formatMessage(globalMessages.save)}
              </span>
            </Button>
          </div>
        </SaveBar>
      </div>
      <div className="xl:w-80">
        <Preview name={user?.displayName ?? ''} />
      </div>
    </div>
  );
};

/**
 * Profile → Settings → Appearance: light or dark, the accent, the dark
 * background and a few extras, kept with the account. Each change shows at
 * once on one's own screen and is kept on Save; leaving without saving puts
 * the saved look back.
 */
const UserAppearanceSettings = () => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { setPreview } = useTheme();
  const { user: currentUser, revalidate: revalidateCurrentUser } = useUser();
  const { user, revalidate } = useUser({ id: Number(router.query.userId) });
  const isOwn = !!user && user.id === currentUser?.id;
  const key = user ? `/api/v1/user/${user.id}/settings/appearance` : null;
  const { data, error, mutate } = useSWR<{
    appearance: Appearance | null;
    serverDefault: ThemeDefaults;
  }>(key);

  const saveLook = async (appearance: Appearance | null) => {
    if (!key) {
      return;
    }
    const response = await axios.post<{
      appearance: Appearance | null;
      serverDefault: ThemeDefaults;
    }>(key, { appearance });
    await mutate(response.data, { revalidate: false });
    // Pages read the look from the signed-in person: take it from there
    // before the preview stops, so nothing flickers back.
    await revalidate();
    if (isOwn) {
      await revalidateCurrentUser();
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.appearance),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.appearance)}</h3>
        <p className="description">
          {intl.formatMessage(
            data && !data.appearance
              ? messages.usingServerDefault
              : messages.description
          )}
        </p>
      </div>
      {!data ? (
        <p className="text-sm text-muted">
          {intl.formatMessage(messages.loadFailed)}
        </p>
      ) : (
        <Formik<Appearance>
          initialValues={
            data.appearance ?? appearanceFromDefaults(data.serverDefault)
          }
          enableReinitialize
          validationSchema={Yup.object().shape({
            customAccent: accentSchema(
              intl.formatMessage(messages.validationColour)
            ),
          })}
          onSubmit={async (values) => {
            try {
              await saveLook({
                ...values,
                customAccent:
                  values.accent === 'custom'
                    ? cleanHexColour(values.customAccent)
                    : undefined,
              });
              addToast(intl.formatMessage(messages.saved), {
                appearance: 'success',
                autoDismiss: true,
              });
            } catch {
              addToast(intl.formatMessage(messages.failed), {
                appearance: 'error',
                autoDismiss: true,
              });
            }
          }}
        >
          {({ resetForm, isSubmitting, setSubmitting }) => (
            <Form>
              <AppearanceFields
                preview={setPreview}
                isOwn={isOwn}
                resetting={isSubmitting}
                onReset={async () => {
                  setSubmitting(true);
                  try {
                    await saveLook(null);
                    resetForm({
                      values: appearanceFromDefaults(data.serverDefault),
                    });
                    addToast(intl.formatMessage(messages.reset), {
                      appearance: 'success',
                      autoDismiss: true,
                    });
                  } catch {
                    addToast(intl.formatMessage(messages.failed), {
                      appearance: 'error',
                      autoDismiss: true,
                    });
                  } finally {
                    setSubmitting(false);
                  }
                }}
              />
            </Form>
          )}
        </Formik>
      )}
      {user && <PersonalCss userId={user.id} isOwn={isOwn} />}
    </>
  );
};

export default UserAppearanceSettings;
