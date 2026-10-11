import defineMessages from '@app/utils/defineMessages';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsGuide', {
  guide: 'How It Works',
  intro:
    'What happens to a request here, what each status means, what steps in when something gets stuck, and where to look when it does. Times are the defaults; Jobs & Cache has the real ones.',

  flowTitle: 'From request to watching',
  flow1:
    'Someone requests a title. It waits for an admin unless their permissions approve it on their own (Users).',
  flow2:
    'Once approved it is sent to Radarr (movies) or Sonarr (series), which search the indexers through Prowlarr and hand what they pick to the download client: qBittorrent or SABnzbd.',
  flow3:
    'When the download finishes, Radarr or Sonarr import it into the library folder, renamed their way.',
  flow4:
    'A minute after an import, Seerr AI asks Plex what it has added, and again each minute a few times until Plex lists it. Otherwise Plex is asked every 5 minutes, and the whole library is read at 3am.',
  flow5:
    'Once Plex lists it, the title is Available and the requester is told, by web push or whatever they have turned on.',

  pillsTitle: 'What the status pills mean',
  pillPending: 'Waiting for an admin to approve it.',
  pillRequested:
    'Approved and with Radarr or Sonarr, but nothing is downloading yet: still searching, or nothing good enough has been found.',
  pillWaiting:
    'Radarr or Sonarr found a release and are holding it for their delay profile, in case a better one turns up. The tooltip says for how long.',
  pillQueued: 'In the download client, waiting its turn.',
  pillDownloading: 'Downloading, with how far along it is.',
  pillStalled:
    'A torrent with no one to download from right now. It may pick up again on its own; one Backfill started is replaced after a while.',
  pillFinishing:
    'Downloaded; the client is verifying, repairing, unpacking or moving it.',
  pillImporting: 'Radarr or Sonarr are adding it to the library folder.',
  pillAdding:
    'In the library folder; Plex has not listed it yet. Usually a minute or two.',
  pillAttention:
    'Held up in Radarr or Sonarr, usually an import it would not make on its own. Open it there to see why.',
  pillFailed: 'The download failed; Radarr or Sonarr look for another.',
  pillPartial:
    'Some of it is in Plex: some episodes of a series, or one season of several.',
  pillAvailable: 'In Plex and ready to watch.',
  pillDeleted: 'Removed from the library, by Maintainerr or by hand.',

  stuckTitle: 'When a title gets stuck',
  stuck1:
    'Backfill (Settings → Backfill) looks every 6 hours for titles Radarr or Sonarr searched for and did not find. It searches Prowlarr itself under every name the title goes by, opens likely packs and checks each file, then downloads only what an admin approves. Approvals come as a Backfill notification; small, safe packs can be approved automatically.',
  stuck2:
    'The admin agent (an AI, with AI set up) looks further when Backfill finds nothing usable: it reads why releases were turned down and searches other ways. It steps in on its own only if that is turned on; otherwise ask it from Backfill, or from a title’s Backfill page.',
  stuck3:
    'Health lists titles that have been processing for over a week, and Search all asks Radarr and Sonarr to search for every one of them.',

  subsTitle: 'Subtitles',
  subs1:
    'Bazarr finds subtitles for what Radarr and Sonarr import. When none exist, Transcribe on a title’s subtitles asks Bazarr’s WhisperAI provider to make them. If Bazarr has paused WhisperAI after an error, Transcribe says so, and Health shows it.',

  lookTitle: 'Where to look when something is wrong',
  lookHealth:
    'Health: every connected service and whether it answers, what Radarr, Sonarr, Prowlarr and Bazarr report as wrong, disks running low, and stuck requests and titles. Admins are sent a Health notification when something newly goes wrong.',
  lookMatch:
    'Plex Match Check (nightly, on Health): folders Plex matched to a different title than Sonarr or Radarr have in them. A wrong match makes the wrong title show as available. Fix it with Fix Match in Plex.',
  lookBackfill:
    'Backfill: what it found, what waits for approval, and its downloads.',
  lookJobs: 'Jobs & Cache: when each job runs, and Run now.',
  lookLogs: 'Logs: everything Seerr AI did, newest first.',

  settingsTitle: 'The settings that matter',
  settingsUsers:
    'Users: who may request, and whose requests are approved on their own.',
  settingsServices:
    'Services: Radarr, Sonarr, Bazarr, Tautulli, Maintainerr and the download clients.',
  settingsBackfill:
    'Backfill: Prowlarr, which download client gets packs, when a title counts as stuck, and what may be approved on its own. Limits and tuning are under Advanced.',
  settingsAi:
    'AI: the provider and model behind AI search, the admin agent and the rest, and a daily limit per person.',
  settingsNotifications:
    'Notifications: how people and admins are told: web push, Discord, email and the rest. Each is off until set up, and each has its own list of what it sends.',
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
    indigo: 'bg-indigo-500 text-white',
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
  const t = (m: keyof typeof messages) => intl.formatMessage(messages[m]);
  const where = (href: string, m: keyof typeof messages) => {
    const [name, ...rest] = t(m).split(': ');
    return (
      <li className="py-1 text-sm text-gray-300">
        <Link
          href={href}
          className="font-medium text-indigo-400 hover:underline"
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
        <ul className="divide-y divide-gray-700/60">
          <Pill label="Pending" tone="yellow">
            {t('pillPending')}
          </Pill>
          <Pill label="Requested" tone="indigo">
            {t('pillRequested')}
          </Pill>
          <Pill label="Waiting" tone="gray">
            {t('pillWaiting')}
          </Pill>
          <Pill label="Queued" tone="gray">
            {t('pillQueued')}
          </Pill>
          <Pill label="Downloading 42%" tone="indigo">
            {t('pillDownloading')}
          </Pill>
          <Pill label="Stalled" tone="yellow">
            {t('pillStalled')}
          </Pill>
          <Pill label="Finishing up" tone="indigo">
            {t('pillFinishing')}
          </Pill>
          <Pill label="Importing" tone="green">
            {t('pillImporting')}
          </Pill>
          <Pill label="Adding to Plex" tone="green">
            {t('pillAdding')}
          </Pill>
          <Pill label="Needs attention" tone="yellow">
            {t('pillAttention')}
          </Pill>
          <Pill label="Download failed" tone="red">
            {t('pillFailed')}
          </Pill>
          <Pill label="Partially Available" tone="green">
            {t('pillPartial')}
          </Pill>
          <Pill label="Available" tone="green">
            {t('pillAvailable')}
          </Pill>
          <Pill label="Deleted" tone="red">
            {t('pillDeleted')}
          </Pill>
        </ul>
      </Section>

      <Section title={t('stuckTitle')}>
        <div className="space-y-3 text-sm text-gray-300">
          <p>{t('stuck1')}</p>
          <p>{t('stuck2')}</p>
          <p>{t('stuck3')}</p>
        </div>
      </Section>

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
