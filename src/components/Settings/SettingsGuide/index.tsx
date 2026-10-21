import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsGuide', {
  guide: 'How It Works',
  intro:
    'How a request moves, what each status means, and what to do when one gets stuck. Times are defaults; see Jobs & Cache.',

  flowTitle: 'From request to watching',
  flow1:
    'Someone requests a title. It waits for approval unless their permissions auto-approve it.',
  flow2:
    'Once approved, it goes to Radarr or Sonarr, which search through Prowlarr and send it to the download client.',
  flow3: 'When it’s downloaded, Radarr or Sonarr import it into the library.',
  flow4:
    'Seerr AI checks the media server a minute after each import, every 5 minutes, and fully at 3am.',
  flow5:
    'Once the media server lists it, it’s Available and the requester is notified.',

  pillsTitle: 'What the status pills mean',
  labelPending: 'Pending',
  labelRequested: 'Requested',
  labelWaiting: 'Waiting',
  labelQueued: 'Queued',
  labelDownloading: 'Downloading {percent}%',
  labelStalled: 'Stalled',
  labelFinishing: 'Finishing up',
  labelImporting: 'Importing',
  labelAdding: 'Adding to library',
  labelAttention: 'Needs attention',
  labelFailed: 'Download failed',
  labelPartial: 'Partially Available',
  labelAvailable: 'Available',
  labelDeleted: 'Deleted',
  pillPending: 'Waiting for an admin to approve it.',
  pillRequested:
    'Approved and with Radarr or Sonarr, but nothing good enough has been found yet.',
  pillWaiting:
    'Radarr or Sonarr are holding a release for their delay profile, in case a better one turns up.',
  pillQueued: 'In the download client, waiting its turn.',
  pillDownloading: 'Downloading, with how far along it is.',
  pillStalled:
    'A torrent no one is seeding right now. It may resume; Backfill replaces its own after a while.',
  pillFinishing:
    'Downloaded; the client is verifying, repairing, unpacking or moving it.',
  pillImporting: 'Radarr or Sonarr are adding it to the library folder.',
  pillAdding:
    'In the library; the media server hasn’t listed it yet. Usually a minute or two.',
  pillAttention:
    'Stuck in Radarr or Sonarr, usually on an import. Open it there to see why.',
  pillFailed: 'The download failed; Radarr or Sonarr look for another.',
  pillPartial:
    'Some of it is in the library, such as some episodes or one season.',
  pillAvailable: 'In the library and ready to watch.',
  pillDeleted: 'Removed from the library, by Maintainerr or by hand.',

  stuckTitle: 'When a title gets stuck',
  stuck1:
    'Backfill looks every 6 hours for titles Radarr or Sonarr couldn’t find, searches Prowlarr under every name, and downloads what an admin approves.',
  stuck2:
    'The admin agent, an AI, looks further when Backfill finds nothing. It runs on its own only if that’s on; otherwise ask it from Backfill.',
  stuck3:
    'Health lists titles processing for over a week; Search all asks Radarr and Sonarr to search for them.',
  stuck4:
    'Download Check, if it’s on, rejects fakes and wrong titles Radarr and Sonarr grab, and sorts out imports that get stuck. Settings → Backfill turns it on, or to Report only.',

  musicTitle: 'Music',
  music1:
    'With a default Lidarr (Services), people can request one album, several or a whole discography, as one request. Lidarr then searches for just those albums.',
  music2:
    'Music Sync runs every 5 minutes. An album is Available once a music library lists it, or with none on, once Lidarr has all its tracks.',
  music3:
    'Health lists albums missing from your media server after a day, requested albums not found after a week, and MusicBrainz problems.',
  music4:
    'Music can be turned off for everyone under Features, or by each person for themselves.',

  subsTitle: 'Subtitles',
  subs1:
    'Bazarr finds subtitles for new imports. When none exist, Transcribe has Bazarr’s WhisperAI make them; Health shows if it’s paused.',

  lookTitle: 'Where to look when something is wrong',
  lookHealth:
    'Health: whether each service answers, what Radarr, Sonarr, Prowlarr and Bazarr report, low disks and stuck titles. Admins are notified of new problems.',
  lookMatch:
    'Match Check (on Health): folders your media server matched to the wrong title. Fix with Fix Match in Plex or Identify in Jellyfin and Emby.',
  lookBackfill:
    'Backfill: what it found, what waits for approval, and its downloads.',
  lookJobs: 'Jobs & Cache: when each job runs, and Run now.',
  lookLogs: 'Logs: everything Seerr AI did, newest first.',

  settingsTitle: 'The settings that matter',
  settingsUsers:
    'Users: who may request, and whose requests are approved on their own.',
  settingsServices:
    'Services: Radarr, Sonarr, Lidarr, Bazarr, Tautulli, Maintainerr and the download clients.',
  settingsBackfill:
    'Backfill: Prowlarr, the download client, when a title counts as stuck, and what’s approved automatically.',
  settingsAi:
    'AI: the provider and model behind the AI features, and a daily limit per person.',
  settingsNotifications:
    'Notifications: web push, Discord, email and more. Each is off until set up.',
});

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="mb-8">
    <h4 className="mb-3 text-lg font-semibold text-gray-200">{title}</h4>
    {children}
  </section>
);

/** One pill and what it means, with the pill drawn as it looks. */
const Pill = ({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'gray' | 'indigo' | 'yellow' | 'red' | 'green';
  children: React.ReactNode;
}) => {
  const tones = {
    gray: 'bg-gray-700 text-gray-100',
    indigo: 'bg-indigo-500 text-on-accent',
    yellow: 'bg-yellow-500 text-yellow-950',
    red: 'bg-red-600 text-white',
    green: 'bg-green-500 text-white',
  };
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <span
        className={`w-fit flex-none rounded-full px-2.5 py-0.5 text-xs font-medium sm:w-40 sm:text-center ${tones[tone]}`}
      >
        {label}
      </span>
      <span className="text-sm text-gray-300">{children}</span>
    </li>
  );
};

/**
 * For admins: how requests, downloads, Backfill and the checks fit
 * together here, in one page, for anyone new to running it.
 */
const SettingsGuide = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const t = (m: keyof typeof messages) => intl.formatMessage(messages[m]);
  const where = (href: string, m: keyof typeof messages) => {
    const [name, ...rest] = t(m).split(': ');
    return (
      <li className="py-1 text-sm text-gray-300">
        <Link
          href={href}
          className="font-medium text-indigo-400 hover:underline light:text-accent-text"
        >
          {name}
        </Link>
        {rest.length ? `: ${rest.join(': ')}` : ''}
      </li>
    );
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h3 className="heading">{t('guide')}</h3>
        <p className="description">{t('intro')}</p>
      </div>

      <Section title={t('flowTitle')}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-300">
          {(['flow1', 'flow2', 'flow3', 'flow4', 'flow5'] as const).map((m) => (
            <li key={m}>{t(m)}</li>
          ))}
        </ol>
      </Section>

      <Section title={t('pillsTitle')}>
        <ul className="guide-pills divide-y divide-gray-700/60 light:divide-subtle">
          <Pill label={t('labelPending')} tone="yellow">
            {t('pillPending')}
          </Pill>
          <Pill label={t('labelRequested')} tone="indigo">
            {t('pillRequested')}
          </Pill>
          <Pill label={t('labelWaiting')} tone="gray">
            {t('pillWaiting')}
          </Pill>
          <Pill label={t('labelQueued')} tone="gray">
            {t('pillQueued')}
          </Pill>
          <Pill
            label={intl.formatMessage(messages.labelDownloading, {
              percent: 42,
            })}
            tone="indigo"
          >
            {t('pillDownloading')}
          </Pill>
          <Pill label={t('labelStalled')} tone="yellow">
            {t('pillStalled')}
          </Pill>
          <Pill label={t('labelFinishing')} tone="indigo">
            {t('pillFinishing')}
          </Pill>
          <Pill label={t('labelImporting')} tone="green">
            {t('pillImporting')}
          </Pill>
          <Pill label={t('labelAdding')} tone="green">
            {t('pillAdding')}
          </Pill>
          <Pill label={t('labelAttention')} tone="yellow">
            {t('pillAttention')}
          </Pill>
          <Pill label={t('labelFailed')} tone="red">
            {t('pillFailed')}
          </Pill>
          <Pill label={t('labelPartial')} tone="green">
            {t('pillPartial')}
          </Pill>
          <Pill label={t('labelAvailable')} tone="green">
            {t('pillAvailable')}
          </Pill>
          <Pill label={t('labelDeleted')} tone="red">
            {t('pillDeleted')}
          </Pill>
        </ul>
      </Section>

      <Section title={t('stuckTitle')}>
        <div className="space-y-3 text-sm text-gray-300">
          <p>{t('stuck1')}</p>
          <p>{t('stuck2')}</p>
          <p>{t('stuck3')}</p>
          <p>{t('stuck4')}</p>
        </div>
      </Section>

      {currentSettings.musicReady && (
        <Section title={t('musicTitle')}>
          <div className="space-y-3 text-sm text-gray-300">
            <p>{t('music1')}</p>
            <p>{t('music2')}</p>
            <p>{t('music3')}</p>
            <p>{t('music4')}</p>
          </div>
        </Section>
      )}

      <Section title={t('subsTitle')}>
        <p className="text-sm text-gray-300">{t('subs1')}</p>
      </Section>

      <Section title={t('lookTitle')}>
        <ul>
          {where('/settings/health', 'lookHealth')}
          {where('/settings/health', 'lookMatch')}
          {where('/backfill', 'lookBackfill')}
          {where('/settings/jobs', 'lookJobs')}
          {where('/settings/logs', 'lookLogs')}
        </ul>
      </Section>

      <Section title={t('settingsTitle')}>
        <ul>
          {where('/settings/users', 'settingsUsers')}
          {where('/settings/services', 'settingsServices')}
          {where('/settings/backfill', 'settingsBackfill')}
          {where('/settings/ai', 'settingsAi')}
          {where('/settings/notifications/email', 'settingsNotifications')}
        </ul>
      </Section>
    </div>
  );
};

export default SettingsGuide;
