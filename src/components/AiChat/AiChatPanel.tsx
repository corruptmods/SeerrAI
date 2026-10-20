import PickForRoom from '@app/components/Ai/PickForRoom';
import AiBulkSheet from '@app/components/AiChat/AiBulkSheet';
import AiTitleCard, { resultLabel } from '@app/components/AiChat/AiTitleCard';
import SlideOver from '@app/components/Common/SlideOver';
import VoiceInputButton, {
  useVoiceInput,
} from '@app/components/Common/VoiceInput';
import useAi, { aiErrorMessage } from '@app/hooks/useAi';
import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { ShrunkPhoto } from '@app/utils/shrinkPhoto';
import { shrinkPhoto } from '@app/utils/shrinkPhoto';
import {
  ArrowDownTrayIcon,
  BookmarkIcon,
  CameraIcon,
  CheckCircleIcon,
  PaperAirplaneIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type { MovieResult, TvResult } from '@server/models/Search';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.AiChat.AiChatPanel', {
  title: 'AI',
  remaining: '{count, plural, one {# answer} other {# answers}} left today',
  intro:
    'Describe what you’re after, even a whole franchise. Open, add to a list or request what it finds.',
  example1: 'the movie where a man relives the same day',
  example2: 'something like the last series I watched, but lighter',
  example3: 'add every Pixar film to a new list',
  example4: 'request all of Christopher Nolan’s films',
  introFix:
    'Or report a problem, like bad subtitles, missing episodes or a file that won’t play, and it gets fixed.',
  fixExample1: 'get English subtitles for Spirited Away',
  fixExample2: 'season 2 episode 5 of Breaking Bad is the wrong episode',
  fixExample3: 'Interstellar has no sound',
  introPhoto: 'Or send a photo of a poster or screen to find what’s in it.',
  attachPhoto: 'Send a Photo',
  removePhoto: 'Remove the Photo',
  photoAlt: 'The photo sent',
  photoUnreadable: 'That photo could not be opened. Try a JPEG or PNG.',
  placeholderPhoto: 'Ask about the photo…',
  placeholder: 'Describe it or ask…',
  placeholderFix: 'Ask, or report a problem…',
  send: 'Send',
  thinking: 'Thinking…',
  nothingFound: 'Nothing matched. Try describing it another way.',
  openFix: 'Follow it',
  confirmFix: 'Go Ahead',
  failed: 'That did not work. Try again.',
  clear: 'Start Over',
  search: 'Search',
  pick: 'Pick for the Room',
  choose: 'Choose',
  doneChoosing: 'Cancel',
  addAll: 'Add to List',
  requestAll: 'Request',
  addSome: 'Add {count} to List',
  requestSome: 'Request {count}',
  chooseTitle: 'Choose {title}',
  setCount:
    '{count, plural, one {# title} other {# titles}} from {name}, oldest first.',
  setCountMore:
    'The {count} best known titles from {name}, oldest first; there are more.',
  showAll: 'Show All {count}',
});

type Title = MovieResult | TvResult;

const keyOf = (title: Title) => `${title.mediaType}:${title.id}`;

interface Turn {
  ask: string;
  /** A small copy of the photo sent with it, if any. */
  photo?: string;
  reply?: string;
  results?: Title[];
  /** A whole set read from TMDB: its name, and whether it was cut short. */
  source?: { name: string; more: boolean };
  /** A fix that was done or started, and the page that follows it. */
  fix?: { kind: string; ok: boolean; link?: string };
  /** A fix that replaces files, offered, waiting for them to confirm it. */
  confirm?: Record<string, unknown>;
  error?: string;
}

/** As long as the server reads a message, or an earlier one sent back. */
const MAX_ASK = 500;

/** Cards shown for a whole set before "Show all". */
const SET_PREVIEW = 12;

interface ChatAction {
  do: 'list' | 'request';
  name?: string;
  /** About titles offered in an earlier answer, not this one's. */
  earlier: boolean;
}

interface Sheet {
  mode: 'list' | 'request';
  titles: Title[];
  name?: string;
}

/**
 * The panel the AI button opens: a short conversation that ends in titles to
 * open or request, and picking for a room. Loaded the first time it is
 * opened, then kept as it is while someone moves around the app; gone when
 * they sign out.
 */
const AiChatPanel = ({
  open,
  onClose,
  canSearch,
  canPick,
}: {
  open: boolean;
  onClose: () => void;
  canSearch: boolean;
  canPick: boolean;
}) => {
  const intl = useIntl();
  const router = useRouter();
  const { remaining, refresh } = useAi();
  const canFix = useFeature('autoFix');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<ShrunkPhoto>();
  const [photoProblem, setPhotoProblem] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'search' | 'pick'>('search');
  const [choosing, setChoosing] = useState<{
    turn: number;
    keys: Set<string>;
  }>();
  const [sheet, setSheet] = useState<Sheet>();
  // Answers whose whole set is shown, not just the first few.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const { hasPermission } = useUser();
  const canRequest = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_MOVIE, Permission.REQUEST_TV],
    { type: 'or' }
  );
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Spoken words fill the box; sending stays with the person, so a misheard
  // word can be put right first.
  const voice = useVoiceInput(
    useCallback((heard: string) => {
      if (heard) {
        setText(heard.slice(0, 500));
      }
    }, [])
  );

  // Opening a title from the panel goes to its page; the panel steps aside,
  // and so does a sheet open in it, rather than coming back with the panel.
  useEffect(() => {
    const leave = () => {
      setSheet(undefined);
      setChoosing(undefined);
      onClose();
    };
    router.events.on('routeChangeStart', leave);
    return () => router.events.off('routeChangeStart', leave);
  }, [router.events, onClose]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns, busy]);

  const showing = !canSearch ? 'pick' : !canPick ? 'search' : view;

  const attach = async (file?: File | null) => {
    if (!file) {
      return;
    }
    setPhotoProblem(false);
    try {
      setPhoto(await shrinkPhoto(file));
      input.current?.focus();
    } catch {
      setPhoto(undefined);
      setPhotoProblem(true);
    }
  };

  const send = async (message: string, withPhoto?: ShrunkPhoto) => {
    const ask = message.trim();
    if ((!ask && !withPhoto) || busy) {
      return;
    }
    setText('');
    setPhoto(undefined);
    setPhotoProblem(false);
    setBusy(true);
    // Only what was asked and offered goes back as context, not the cards
    // or the photos.
    const earlier = turns
      .filter((t) => !t.error)
      .slice(-3)
      .map((t) => ({
        ask: (t.photo ? `(sent a photo) ${t.ask}`.trim() : t.ask).slice(
          0,
          MAX_ASK
        ),
        reply: t.reply,
        offered: (t.results ?? []).slice(0, 8).map(resultLabel),
      }));
    const shown = withPhoto?.thumbnail;
    setTurns((all) => [...all, { ask, photo: shown }]);
    try {
      const response = await axios.post<{
        reply: string;
        results: Title[];
        source?: Turn['source'];
        action?: ChatAction;
        fix?: Turn['fix'];
        confirm?: Turn['confirm'];
      }>('/api/v1/ai/chat', {
        message: ask,
        turns: earlier,
        ...(withPhoto && {
          image: { type: withPhoto.type, data: withPhoto.data },
        }),
      });
      const { reply, results, source, action, fix, confirm } = response.data;
      setTurns((all) => [
        ...all.slice(0, -1),
        { ask, photo: shown, reply, results, source, fix, confirm },
      ]);
      // Asked to list or request titles: set it up to confirm, never more.
      if (action) {
        const titles = action.earlier
          ? ([...turns].reverse().find((t) => t.results?.length)?.results ?? [])
          : results;
        if (titles.length && (action.do === 'list' || canRequest)) {
          setSheet({ mode: action.do, titles, name: action.name });
        }
      }
    } catch (e) {
      setTurns((all) => [
        ...all.slice(0, -1),
        {
          ask,
          photo: shown,
          error: aiErrorMessage(e, intl.formatMessage(messages.failed), intl),
        },
      ]);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // A fix that replaces files, confirmed: filed and started, and the
  // answer it was offered in says so.
  const confirmFix = async (index: number) => {
    const turn = turns[index];
    if (!turn?.confirm || busy) {
      return;
    }
    setBusy(true);
    const update = (change: Partial<Turn>) =>
      setTurns((all) =>
        all.map((t, i) => (i === index ? { ...t, ...change } : t))
      );
    try {
      const response = await axios.post<{ reply: string; fix?: Turn['fix'] }>(
        '/api/v1/ai/fix',
        turn.confirm
      );
      update({
        reply: response.data.reply,
        fix: response.data.fix,
        confirm: undefined,
        error: undefined,
      });
    } catch (e) {
      update({
        error: aiErrorMessage(e, intl.formatMessage(messages.failed), intl),
      });
    } finally {
      setBusy(false);
    }
  };

  const placeholder = intl.formatMessage(
    photo
      ? messages.placeholderPhoto
      : canFix
        ? messages.placeholderFix
        : messages.placeholder
  );

  // The microphone until there is something to send, then Send; a photo on
  // its own can be sent too. While listening it stays, so it can be stopped.
  const showMic =
    voice.available && (voice.listening || (!text.trim() && !photo));

  const form = (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        send(text, photo);
      }}
    >
      {(photo || photoProblem) && (
        <div className="flex items-center gap-2">
          {photo && (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.thumbnail}
                alt={intl.formatMessage(messages.photoAlt)}
                className="h-16 w-auto max-w-[8rem] rounded-lg object-cover ring-1 ring-gray-600"
              />
              <button
                type="button"
                onClick={() => setPhoto(undefined)}
                aria-label={intl.formatMessage(messages.removePhoto)}
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-gray-800 text-gray-200 ring-1 ring-gray-600 hover:text-strong"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          )}
          {photoProblem && (
            <p className="text-xs text-red-300 light:text-danger-text">
              {intl.formatMessage(messages.photoUnreadable)}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor="ai-chat-input" className="sr-only">
          {placeholder}
        </label>
        <div className="relative min-w-0 flex-1">
          <input
            ref={input}
            id="ai-chat-input"
            type="text"
            autoComplete="off"
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
            // A picture copied on a computer can be pasted straight in.
            onPaste={(e) => {
              const file = [...e.clipboardData.files].find((f) =>
                f.type.startsWith('image/')
              );
              if (file) {
                e.preventDefault();
                attach(file);
              }
            }}
            placeholder={placeholder}
            className="w-full rounded-full border border-gray-600 bg-gray-900/80 px-4 py-2 text-strong placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-0"
          />
          {/* On a phone this offers the camera or the photo library. */}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              attach(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={busy}
          aria-label={intl.formatMessage(messages.attachPhoto)}
          title={intl.formatMessage(messages.attachPhoto)}
          className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-gray-600 bg-gray-900/80 text-gray-300 transition hover:text-strong disabled:opacity-50"
        >
          <CameraIcon className="h-5 w-5" />
        </button>
        {/* One button: the microphone until there is something to send. */}
        {showMic ? (
          <VoiceInputButton
            className={`h-10 w-10 ${
              voice.listening
                ? ''
                : 'bg-accent !text-on-accent hover:bg-accent-hover'
            }`}
            listening={voice.listening}
            onToggle={() => {
              if (!voice.listening) {
                input.current?.focus();
              }
              voice.toggle();
            }}
          />
        ) : (
          <button
            type="submit"
            disabled={busy || (!text.trim() && !photo)}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:bg-accent-hover disabled:opacity-50"
            aria-label={intl.formatMessage(messages.send)}
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        )}
      </div>
    </form>
  );

  return (
    <SlideOver
      show={open}
      title={intl.formatMessage(messages.title)}
      subText={
        remaining === null
          ? undefined
          : intl.formatMessage(messages.remaining, { count: remaining })
      }
      onClose={onClose}
      footer={showing === 'pick' ? undefined : form}
    >
      {canSearch && canPick && (
        <div className="mb-4 flex gap-2" role="tablist">
          {(['search', 'pick'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={showing === tab}
              onClick={() => setView(tab)}
              className={`rounded-full px-3 py-1 text-sm ${
                showing === tab
                  ? 'bg-accent text-on-accent'
                  : 'bg-gray-900/60 text-gray-300 ring-1 ring-gray-700 hover:text-strong'
              }`}
            >
              {intl.formatMessage(
                tab === 'search' ? messages.search : messages.pick
              )}
            </button>
          ))}
        </div>
      )}
      {showing === 'pick' ? (
        <PickForRoom />
      ) : (
        // The conversation scrolls; the message box is the panel's footer,
        // so it stays put however long the conversation gets.
        <div className="flex flex-col" data-testid="ai-chat">
          {turns.length > 0 && (
            <button
              type="button"
              className="mb-3 self-end text-xs text-gray-400 hover:text-strong"
              onClick={() => {
                setTurns([]);
                setChoosing(undefined);
                setExpanded(new Set());
              }}
              disabled={busy}
            >
              {intl.formatMessage(messages.clear)}
            </button>
          )}
          <div className="space-y-6 pb-4">
            {turns.length === 0 && (
              <div className="space-y-3 text-sm text-gray-300">
                <p>{intl.formatMessage(messages.intro)}</p>
                {canFix && <p>{intl.formatMessage(messages.introFix)}</p>}
                <p>{intl.formatMessage(messages.introPhoto)}</p>
                {[
                  messages.example1,
                  messages.example2,
                  messages.example3,
                  messages.example4,
                  ...(canFix
                    ? [
                        messages.fixExample1,
                        messages.fixExample2,
                        messages.fixExample3,
                      ]
                    : []),
                ].map((example) => (
                  <button
                    key={example.id}
                    type="button"
                    onClick={() => send(intl.formatMessage(example))}
                    className="block w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-left text-gray-200 transition hover:border-gray-500"
                  >
                    “{intl.formatMessage(example)}”
                  </button>
                ))}
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={i} className="space-y-3">
                <div className="ml-8 flex flex-col items-end gap-2">
                  {turn.photo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={turn.photo}
                      alt={intl.formatMessage(messages.photoAlt)}
                      className="max-h-40 w-auto max-w-[12rem] rounded-lg object-cover ring-1 ring-indigo-700"
                    />
                  )}
                  {turn.ask && (
                    <div className="w-full rounded-lg bg-indigo-700/60 px-3 py-2 text-sm text-on-accent light:bg-accent">
                      {turn.ask}
                    </div>
                  )}
                </div>
                {turn.error && (
                  <div className="rounded-lg border border-red-700 bg-red-900/40 px-3 py-2 text-sm text-red-100 light:bg-danger-soft/15 light:text-danger-text">
                    {turn.error}
                  </div>
                )}
                {turn.reply !== undefined && (
                  <div className="mr-8 whitespace-pre-line text-sm text-gray-200">
                    {turn.fix && (
                      <WrenchScrewdriverIcon
                        className={`mr-1.5 inline h-4 w-4 align-text-bottom ${
                          turn.fix.ok ? 'text-green-400' : 'text-yellow-400'
                        }`}
                      />
                    )}
                    {turn.reply ||
                      (!turn.results?.length &&
                        intl.formatMessage(messages.nothingFound))}
                  </div>
                )}
                {turn.confirm && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => confirmFix(i)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-50"
                  >
                    <WrenchScrewdriverIcon className="h-4 w-4" />
                    {intl.formatMessage(messages.confirmFix)}
                  </button>
                )}
                {turn.fix?.link && (
                  <button
                    type="button"
                    onClick={() => router.push(turn.fix!.link!)}
                    className="text-sm font-semibold text-indigo-300 hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
                  >
                    {intl.formatMessage(messages.openFix)} →
                  </button>
                )}
                {!!turn.results?.length && (
                  <>
                    {turn.source && (
                      <p className="text-xs text-gray-400">
                        {intl.formatMessage(
                          turn.source.more
                            ? messages.setCountMore
                            : messages.setCount,
                          {
                            count: turn.results.length,
                            name: turn.source.name,
                          }
                        )}
                      </p>
                    )}
                    <ul className="cards-vertical">
                      {(turn.source && !expanded.has(i) && choosing?.turn !== i
                        ? turn.results.slice(0, SET_PREVIEW)
                        : turn.results
                      ).map((result) => {
                        const picking = choosing?.turn === i;
                        const picked =
                          picking && choosing.keys.has(keyOf(result));
                        return (
                          <li
                            key={`${result.mediaType}-${result.id}`}
                            className="relative"
                          >
                            <AiTitleCard result={result} />
                            {picking && (
                              // While choosing, a tap chooses the title
                              // rather than opening it.
                              <button
                                type="button"
                                aria-pressed={picked}
                                aria-label={intl.formatMessage(
                                  messages.chooseTitle,
                                  { title: resultLabel(result) }
                                )}
                                onClick={() =>
                                  setChoosing((now) => {
                                    if (!now) {
                                      return now;
                                    }
                                    const keys = new Set(now.keys);
                                    if (keys.has(keyOf(result))) {
                                      keys.delete(keyOf(result));
                                    } else {
                                      keys.add(keyOf(result));
                                    }
                                    return { ...now, keys };
                                  })
                                }
                                className={`absolute inset-0 z-10 flex items-start justify-end rounded-xl p-2 ring-2 transition ${
                                  picked
                                    ? 'bg-indigo-900/30 ring-indigo-400'
                                    : 'bg-gray-900/50 ring-transparent'
                                }`}
                              >
                                <CheckCircleIcon
                                  className={`h-7 w-7 rounded-full ${
                                    picked
                                      ? 'bg-indigo-500 text-on-accent'
                                      : 'bg-gray-900/70 text-gray-400'
                                  }`}
                                />
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {turn.source &&
                      turn.results.length > SET_PREVIEW &&
                      !expanded.has(i) &&
                      choosing?.turn !== i && (
                        <button
                          type="button"
                          className="text-sm font-semibold text-indigo-300 hover:text-indigo-200 light:text-accent-text light:hover:text-accent-text"
                          onClick={() =>
                            setExpanded((now) => new Set(now).add(i))
                          }
                        >
                          {intl.formatMessage(messages.showAll, {
                            count: turn.results.length,
                          })}
                        </button>
                      )}
                    <ResultActions
                      titles={turn.results}
                      choosing={
                        choosing?.turn === i ? choosing.keys : undefined
                      }
                      canRequest={canRequest}
                      onChoose={() =>
                        setChoosing(
                          choosing?.turn === i
                            ? undefined
                            : { turn: i, keys: new Set() }
                        )
                      }
                      onOpen={(mode, titles) => setSheet({ mode, titles })}
                    />
                  </>
                )}
              </div>
            ))}
            {busy && (
              <div className="animate-pulse text-sm text-gray-400">
                {intl.formatMessage(messages.thinking)}
              </div>
            )}
            {/* Scrolled to after each answer. */}
            <div ref={end} />
          </div>
        </div>
      )}
      {sheet && (
        <AiBulkSheet
          mode={sheet.mode}
          titles={sheet.titles}
          suggestedName={sheet.name}
          onRequested={(keys) =>
            setTurns((all) =>
              all.map((turn) => ({
                ...turn,
                results: turn.results?.map((result) =>
                  keys.includes(keyOf(result)) &&
                  (!result.mediaInfo ||
                    result.mediaInfo.status === MediaStatus.UNKNOWN ||
                    result.mediaInfo.status === MediaStatus.DELETED)
                    ? ({
                        ...result,
                        mediaInfo: {
                          ...result.mediaInfo,
                          status: MediaStatus.PENDING,
                        },
                      } as Title)
                    : result
                ),
              }))
            )
          }
          onClose={() => {
            setSheet(undefined);
            setChoosing(undefined);
          }}
        />
      )}
    </SlideOver>
  );
};

/**
 * Under an answer's titles: put them on a list or request them, all of
 * them, or only the ones chosen.
 */
const ResultActions = ({
  titles,
  choosing,
  canRequest,
  onChoose,
  onOpen,
}: {
  titles: Title[];
  choosing?: Set<string>;
  canRequest: boolean;
  onChoose: () => void;
  onOpen: (mode: 'list' | 'request', titles: Title[]) => void;
}) => {
  const intl = useIntl();
  const picked = choosing
    ? titles.filter((t) => choosing.has(keyOf(t)))
    : titles;
  const none = !!choosing && !picked.length;
  const chip =
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onChoose}
        aria-pressed={!!choosing}
        className={`${chip} ${
          choosing
            ? 'bg-accent text-on-accent'
            : 'bg-gray-900/60 text-gray-300 ring-1 ring-gray-700 hover:text-strong'
        }`}
      >
        {choosing
          ? intl.formatMessage(messages.doneChoosing)
          : intl.formatMessage(messages.choose)}
      </button>
      <span className="flex-1" />
      <button
        type="button"
        disabled={none}
        onClick={() => onOpen('list', picked)}
        className={`${chip} bg-gray-900/60 text-gray-200 ring-1 ring-gray-700 hover:text-strong`}
      >
        <BookmarkIcon className="h-4 w-4" />
        {choosing
          ? intl.formatMessage(messages.addSome, { count: picked.length })
          : intl.formatMessage(messages.addAll)}
      </button>
      {canRequest && (
        <button
          type="button"
          disabled={none}
          onClick={() => onOpen('request', picked)}
          className={`${chip} bg-accent/accent-fill text-on-accent hover:bg-accent`}
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          {choosing
            ? intl.formatMessage(messages.requestSome, {
                count: picked.length,
              })
            : intl.formatMessage(messages.requestAll)}
        </button>
      )}
    </div>
  );
};

export default AiChatPanel;
