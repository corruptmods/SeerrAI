import Alert from '@app/components/Common/Alert';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

/*
 * Signing in, or linking Silo, with a code approved in Silo: Silo's Quick
 * Connect. Shows the code and a link to Silo's page for it, and checks until
 * it is approved, refused or expired.
 */

const messages = defineMessages('components.Login.SiloCodeModal', {
  title: 'Sign in with a code',
  linkTitle: 'Link Silo with a code',
  instructions:
    'Approve this code in Silo, signed in as yourself, on any device.',
  openSilo: 'Open Silo to approve it',
  waiting: 'Waiting for approval…',
  opened: 'Someone opened this code in Silo. Waiting for them to approve it…',
  denied: 'This code was refused in Silo.',
  expired: 'This code has expired.',
  failed: 'Silo could not be asked for a code. Try again in a moment.',
  tryAgain: 'New Code',
  cancel: 'Cancel',
});

interface SiloCode {
  handle: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

interface SiloCodeModalProps {
  /** Where codes are started and checked (…/device/start, …/check). */
  endpoint: string;
  /** Linking Silo, rather than signing in. */
  linking?: boolean;
  onApproved: () => void;
  onClose: () => void;
  /** Words for a refusal the server explains (an error code). */
  describeError?: (code: string | undefined, status?: number) => string;
}

type State = 'loading' | 'waiting' | 'opened' | 'denied' | 'expired' | 'failed';

const SiloCodeModal = ({
  endpoint,
  linking,
  onApproved,
  onClose,
  describeError,
}: SiloCodeModalProps) => {
  const intl = useIntl();
  const [code, setCode] = useState<SiloCode>();
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const check = useCallback(
    async (current: SiloCode) => {
      try {
        const { data } = await axios.post<{
          status: 'pending' | 'approved' | 'denied' | 'expired';
          opened?: boolean;
        }>(`${endpoint}/device/check`, { handle: current.handle });
        if (!live.current) return;
        if (data.status === 'approved') {
          onApproved();
          return;
        }
        if (data.status === 'pending') {
          setState(data.opened ? 'opened' : 'waiting');
          timer.current = setTimeout(
            () => check(current),
            current.interval * 1000
          );
          return;
        }
        setState(data.status);
      } catch (e) {
        if (!live.current) return;
        const response = e?.response;
        setError(
          describeError?.(
            response?.data?.message ?? response?.data?.code,
            response?.status
          ) ?? response?.data?.message
        );
        setState('failed');
      }
    },
    [endpoint, onApproved, describeError]
  );

  const start = useCallback(async () => {
    stop();
    setState('loading');
    setError(undefined);
    try {
      const { data } = await axios.post<SiloCode>(`${endpoint}/device/start`);
      if (!live.current) return;
      setCode(data);
      setState('waiting');
      timer.current = setTimeout(() => check(data), data.interval * 1000);
    } catch (e) {
      if (!live.current) return;
      setError(e?.response?.data?.message);
      setState('failed');
    }
  }, [endpoint, check]);

  useEffect(() => {
    live.current = true;
    start();
    return () => {
      live.current = false;
      stop();
    };
    // Started once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    stop();
    // Withdrawn in Silo too, signing in or linking alike.
    if (code && (state === 'waiting' || state === 'opened')) {
      axios
        .post(`${endpoint}/device/cancel`, { handle: code.handle })
        .catch(() => undefined);
    }
    onClose();
  };

  const ended = state === 'denied' || state === 'expired' || state === 'failed';

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(
          linking ? messages.linkTitle : messages.title
        )}
        onCancel={close}
        cancelText={intl.formatMessage(messages.cancel)}
        dialogClass="sm:max-w-lg"
        {...(ended
          ? { okText: intl.formatMessage(messages.tryAgain), onOk: start }
          : {})}
      >
        {state === 'loading' && (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        )}
        {(state === 'waiting' || state === 'opened') && code && (
          <div className="flex flex-col items-center space-y-4">
            <p className="text-center text-gray-300">
              {intl.formatMessage(messages.instructions)}
            </p>
            <div
              className="rounded-lg bg-gray-700 px-8 py-4"
              data-testid="silo-user-code"
            >
              <span className="text-4xl font-bold tracking-wider text-strong">
                {code.userCode.replace('-', ' ')}
              </span>
            </div>
            <a
              href={code.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-sm text-accent-text hover:underline"
            >
              {intl.formatMessage(messages.openSilo)}
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
            <div className="flex items-center space-x-2 text-sm text-gray-400">
              <div className="h-4 w-4">
                <LoadingSpinner />
              </div>
              <span>
                {intl.formatMessage(
                  state === 'opened' ? messages.opened : messages.waiting
                )}
              </span>
            </div>
          </div>
        )}
        {ended && (
          <Alert
            type="error"
            title={
              state === 'failed'
                ? (error ?? intl.formatMessage(messages.failed))
                : intl.formatMessage(
                    state === 'denied' ? messages.denied : messages.expired
                  )
            }
          />
        )}
      </Modal>
    </Transition>
  );
};

export default SiloCodeModal;
