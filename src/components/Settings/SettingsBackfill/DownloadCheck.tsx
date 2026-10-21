import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Settings.SettingsBackfill.DownloadCheck',
  {
    title: 'Download Check',
    description:
      'Looks at what Sonarr and Radarr grab, before it downloads and when its import gets stuck. Rejects fakes and wrong titles, imports the right title under another name, and leaves the rest for you. It works without the rest of Backfill.',
    off: 'Off',
    offTip: 'Nothing is checked.',
    report: 'Report only',
    reportTip:
      'Lists what it would do on the <link>Backfill page</link>, and changes nothing.',
    on: 'On',
    onTip: 'Acts on what it finds.',
    torrentFiles:
      'Torrents’ files are checked too when your torrent client is added in Settings → Services.',
    saved: 'Download Check is {mode}.',
    failed: 'That could not be saved.',
  }
);

export type DownloadCheckMode = 'off' | 'report' | 'on';

const MODES: DownloadCheckMode[] = ['off', 'report', 'on'];

/**
 * Download Check's switch, saved as soon as it's changed, apart from the
 * form above: it needs nothing else of Backfill's.
 */
const DownloadCheck = ({ initial }: { initial: DownloadCheckMode }) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [mode, setMode] = useState<DownloadCheckMode>(initial);
  const [busy, setBusy] = useState(false);

  const change = async (next: DownloadCheckMode) => {
    const before = mode;
    setMode(next);
    setBusy(true);
    try {
      await axios.put('/api/v1/settings/backfill/download-check', {
        mode: next,
      });
      addToast(
        intl.formatMessage(messages.saved, {
          mode: intl.formatMessage(messages[next]).toLowerCase(),
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      setMode(before);
      addToast(
        axios.isAxiosError(e) && e.response?.data?.message
          ? String(e.response.data.message)
          : intl.formatMessage(messages.failed),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setBusy(false);
    }
  };

  const tips: Record<DownloadCheckMode, React.ReactNode> = {
    off: intl.formatMessage(messages.offTip),
    report: intl.formatMessage(messages.reportTip, {
      link: (text: React.ReactNode) => (
        <Link
          key="link"
          href="/backfill#download-check"
          className="text-indigo-400 hover:underline light:text-accent-text"
        >
          {text}
        </Link>
      ),
    }),
    on: intl.formatMessage(messages.onTip),
  };

  return (
    <section aria-labelledby="download-check" className="mt-10">
      <h3 id="download-check" className="heading">
        {intl.formatMessage(messages.title)}
      </h3>
      <p className="description">{intl.formatMessage(messages.description)}</p>
      <div className="section">
        <div
          className="space-y-3"
          role="radiogroup"
          aria-labelledby="download-check"
        >
          <div className="space-y-3">
            {MODES.map((m) => (
              <label key={m} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="download-check-mode"
                  checked={mode === m}
                  disabled={busy}
                  onChange={() => void change(m)}
                />
                <span className="font-medium text-strong">
                  {intl.formatMessage(messages[m])}
                  <span className="block text-sm font-normal text-gray-400">
                    {tips[m]}
                  </span>
                </span>
              </label>
            ))}
            <p className="pt-1 text-sm text-gray-500">
              {intl.formatMessage(messages.torrentFiles)}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default DownloadCheck;
