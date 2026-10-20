import { useAiAnswer } from '@app/components/Ai/AiPanel';
import AiTitleCard from '@app/components/AiChat/AiTitleCard';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import type { MovieResult, TvResult } from '@server/models/Search';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Ai.PickForRoom', {
  intro: 'Choose who’s watching to get three titles you’d all enjoy.',
  who: 'Who is watching',
  whoNote: 'Only people you share a watch list with, unless they’ve opted out.',
  you: 'You',
  kind: 'Looking for',
  any: 'Anything',
  movies: 'A movie',
  series: 'A series',
  mood: 'In the mood for (optional)',
  moodPlaceholder: 'something light, a thriller, under two hours…',
  availableOnly: 'Only what is ready to watch',
  pick: 'Pick for Us',
  thinking: 'Thinking…',
});

interface Person {
  id: number;
  displayName: string;
  avatar: string;
}

interface Pick {
  reason: string;
  result: MovieResult | TvResult;
}

/**
 * Three titles a group would enjoy together. Everyone listed has watch
 * history and has not turned this off for themselves.
 */
const PickForRoom = () => {
  const intl = useIntl();
  const { user } = useUser();
  const { data: people } = useSWR<Person[]>('/api/v1/ai/pick/people');
  const [chosen, setChosen] = useState<number[]>([]);
  const [kind, setKind] = useState<'any' | 'movie' | 'tv'>('any');
  const [mood, setMood] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);
  const { busy, answer, error, ask } = useAiAnswer<Pick[]>();

  const others = (people ?? []).filter((p) => p.id !== user?.id);
  const toggle = (id: number) =>
    setChosen((now) =>
      now.includes(id) ? now.filter((x) => x !== id) : [...now, id].slice(0, 5)
    );

  const pick = () =>
    ask(async () => {
      const response = await axios.post<Pick[]>('/api/v1/ai/pick', {
        people: chosen,
        kind,
        mood: mood.trim() || undefined,
        availableOnly,
      });
      return response.data;
    });

  return (
    <div className="space-y-4 text-sm text-gray-200" data-testid="ai-pick">
      <p className="text-gray-300">{intl.formatMessage(messages.intro)}</p>
      <fieldset>
        <legend className="mb-2 font-semibold text-strong">
          {intl.formatMessage(messages.who)}
        </legend>
        <p className="mb-2 text-xs text-gray-400">
          {intl.formatMessage(messages.whoNote)}
        </p>
        <div className="flex flex-wrap gap-2">
          <span className="flex items-center gap-2 rounded-full bg-indigo-700/60 px-3 py-1 light:bg-accent-soft/15">
            {intl.formatMessage(messages.you)}
          </span>
          {others.map((person) => (
            <label
              key={person.id}
              className={`flex cursor-pointer items-center gap-2 rounded-full px-3 py-1 ring-1 ${
                chosen.includes(person.id)
                  ? 'bg-indigo-700/60 ring-indigo-500 light:bg-accent-soft/15'
                  : 'bg-gray-900/60 ring-gray-700'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={chosen.includes(person.id)}
                onChange={() => toggle(person.id)}
              />
              <CachedImage
                type="avatar"
                src={person.avatar}
                alt=""
                width={20}
                height={20}
                className="h-5 w-5 rounded-full"
              />
              {person.displayName}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="block text-gray-400">
            {intl.formatMessage(messages.kind)}
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'any' | 'movie' | 'tv')}
          >
            <option value="any">{intl.formatMessage(messages.any)}</option>
            <option value="movie">{intl.formatMessage(messages.movies)}</option>
            <option value="tv">{intl.formatMessage(messages.series)}</option>
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="flex-none"
            checked={availableOnly}
            onChange={(e) => setAvailableOnly(e.target.checked)}
          />
          <span>{intl.formatMessage(messages.availableOnly)}</span>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="block text-gray-400">
          {intl.formatMessage(messages.mood)}
        </span>
        <input
          type="text"
          maxLength={150}
          value={mood}
          onChange={(e) => setMood(e.target.value)}
          placeholder={intl.formatMessage(messages.moodPlaceholder)}
        />
      </label>
      <Button buttonType="primary" onClick={pick} disabled={busy}>
        <SparklesIcon />
        <span>
          {intl.formatMessage(busy ? messages.thinking : messages.pick)}
        </span>
      </Button>
      {error && (
        <div
          className="rounded-lg border border-red-700 bg-red-900/40 px-3 py-2 text-red-100 light:bg-danger-soft/15 light:text-danger-text"
          role="alert"
        >
          {error}
        </div>
      )}
      {!!answer?.length && (
        <ul className="space-y-4">
          {answer.map((p) => (
            <li
              key={`${p.result.mediaType}-${p.result.id}`}
              className="flex gap-3"
            >
              <div className="w-28 flex-none">
                <AiTitleCard result={p.result} />
              </div>
              <p className="text-gray-300">{p.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PickForRoom;
