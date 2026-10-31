import type { ButtonType } from '@app/components/Common/Button';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useClickOutside from '@app/hooks/useClickOutside';
import useDialogFocus from '@app/hooks/useDialogFocus';
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import globalMessages from '@app/i18n/globalMessages';
import { Transition, TransitionChild } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import type { MouseEvent } from 'react';
import React, { Fragment, useEffect, useId, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useIntl } from 'react-intl';

interface ModalProps {
  title?: string;
  subTitle?: string;
  onCancel?: (e?: MouseEvent<HTMLElement>) => void;
  onOk?: (e?: MouseEvent<HTMLButtonElement>) => void;
  onSecondary?: (e?: MouseEvent<HTMLButtonElement>) => void;
  onTertiary?: (e?: MouseEvent<HTMLButtonElement>) => void;
  cancelText?: string;
  okText?: string;
  secondaryText?: string;
  tertiaryText?: string;
  okDisabled?: boolean;
  cancelButtonType?: ButtonType;
  okButtonType?: ButtonType;
  secondaryButtonType?: ButtonType;
  secondaryDisabled?: boolean;
  tertiaryDisabled?: boolean;
  tertiaryButtonType?: ButtonType;
  okButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  cancelButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  secondaryButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  tertiaryButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  disableScrollLock?: boolean;
  backgroundClickable?: boolean;
  loading?: boolean;
  backdrop?: string;
  children?: React.ReactNode;
  dialogClass?: string;
  /**
   * An X in the top corner that does what Cancel does, so a long dialog can
   * be closed without scrolling to its buttons.
   */
  showCloseButton?: boolean;
}

const Modal = React.forwardRef<HTMLDivElement, ModalProps>(
  (
    {
      title,
      subTitle,
      onCancel,
      onOk,
      cancelText,
      okText,
      okDisabled = false,
      cancelButtonType = 'default',
      okButtonType = 'primary',
      children,
      disableScrollLock,
      backgroundClickable = true,
      secondaryButtonType = 'default',
      secondaryDisabled = false,
      onSecondary,
      secondaryText,
      tertiaryButtonType = 'default',
      tertiaryDisabled = false,
      tertiaryText,
      loading = false,
      onTertiary,
      backdrop,
      dialogClass,
      showCloseButton = false,
      okButtonProps,
      cancelButtonProps,
      secondaryButtonProps,
      tertiaryButtonProps,
    },
    parentRef
  ) => {
    const intl = useIntl();
    const modalRef = useRef<HTMLDivElement>(null);
    const backgroundClickableRef = useRef(backgroundClickable); // This ref is used to detect state change inside the useClickOutside hook
    useEffect(() => {
      backgroundClickableRef.current = backgroundClickable;
    }, [backgroundClickable]);
    useClickOutside(modalRef, () => {
      if (onCancel && backgroundClickableRef.current) {
        onCancel();
      }
    });
    useLockBodyScroll(true, disableScrollLock);
    // Escape closes it as a click outside would; a dialog that may not be
    // closed by a stray click (one holding unsaved work) keeps to its buttons.
    useDialogFocus(modalRef, {
      onEscape: () => {
        if (onCancel && backgroundClickableRef.current) {
          onCancel();
        }
      },
      ready: !loading,
    });
    const titleId = useId();
    const subTitleId = useId();

    return ReactDOM.createPortal(
      <TransitionChild
        as="div"
        className="fixed bottom-0 left-0 right-0 top-0 z-50 flex h-full w-full items-center justify-center bg-overlay/70"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        ref={parentRef}
      >
        <Transition
          appear
          as={Fragment}
          enter="transition duration-300"
          enterFrom="opacity-0 scale-75"
          enterTo="opacity-100 scale-100"
          leave="transition-opacity duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          show={loading}
        >
          <div style={{ position: 'absolute' }}>
            <LoadingSpinner />
          </div>
        </Transition>
        <Transition
          className={`hide-scrollbar relative inline-block w-full overflow-auto bg-surface px-4 pb-4 pt-4 text-left align-bottom shadow-xl ring-1 ring-subtle transition-all focus:outline-none sm:my-8 sm:max-w-3xl sm:rounded-lg sm:align-middle ${dialogClass}`}
          role="dialog"
          data-seerr="modal"
          aria-modal="true"
          aria-labelledby={title ? titleId : subTitle ? subTitleId : undefined}
          aria-describedby={title && subTitle ? subTitleId : undefined}
          tabIndex={-1}
          style={{
            maxHeight: 'calc(100% - env(safe-area-inset-top) * 2)',
          }}
          appear
          as="div"
          enter="transition duration-300"
          enterFrom="opacity-0 scale-75"
          enterTo="opacity-100 scale-100"
          leave="transition-opacity duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          show={!loading}
          ref={modalRef}
        >
          {/*
            Sticky, in a zero-height strip at the top of the panel, which is
            what scrolls: the X stays in reach however far down a long dialog
            has been scrolled.
          */}
          {showCloseButton && onCancel && (
            <div className="sticky top-0 z-20 flex h-0 justify-end">
              <button
                type="button"
                onClick={onCancel}
                aria-label={intl.formatMessage(globalMessages.close)}
                className="-mr-1 -mt-1 h-8 w-8 rounded-md bg-surface/panel p-1 text-muted transition duration-150 hover:text-strong focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
          )}
          {backdrop && (
            <div className="absolute left-0 right-0 top-0 z-0 h-64 max-h-full w-full">
              <CachedImage
                type="tmdb"
                alt=""
                src={backdrop}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                fill
                priority
                // The dialog is at most 48rem wide.
                sizes="(min-width: 640px) 768px, 100vw"
              />
              {/* Fades into the window's own colour, light or dark. */}
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'linear-gradient(180deg, rgb(var(--surface) / 0.75) 0%, rgb(var(--surface)) 100%)',
                }}
              />
            </div>
          )}
          <div className="relative -mx-4 overflow-x-hidden px-4 pt-0.5 sm:flex sm:items-center">
            <div
              className={`mt-3 min-w-0 text-center text-strong sm:mt-0 sm:text-left ${
                showCloseButton ? 'px-8 sm:pl-0 sm:pr-10' : ''
              }`}
            >
              {(title || subTitle) && (
                <div className="flex flex-col space-y-1">
                  {title && (
                    <span
                      className="text-overseerr break-words pb-0.5 text-2xl font-bold leading-7"
                      id={titleId}
                      data-testid="modal-title"
                    >
                      {title}
                    </span>
                  )}
                  {subTitle && (
                    <span
                      className="break-words text-lg font-semibold leading-6 text-gray-200"
                      id={subTitleId}
                      data-testid="modal-title"
                    >
                      {subTitle}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {children && (
            <div
              className={`relative mt-4 text-sm leading-5 text-default ${
                !(onCancel || onOk || onSecondary || onTertiary) ? 'mb-3' : ''
              }`}
            >
              {children}
            </div>
          )}
          {(onCancel || onOk || onSecondary || onTertiary) && (
            <div className="relative mt-5 flex flex-row-reverse justify-center sm:mt-4 sm:justify-start">
              {typeof onOk === 'function' && (
                <Button
                  buttonType={okButtonType}
                  onClick={onOk}
                  className="ml-3"
                  disabled={okDisabled}
                  data-testid="modal-ok-button"
                  {...okButtonProps}
                >
                  {okText ? okText : 'Ok'}
                </Button>
              )}
              {typeof onSecondary === 'function' && secondaryText && (
                <Button
                  buttonType={secondaryButtonType}
                  onClick={onSecondary}
                  className="ml-3"
                  disabled={secondaryDisabled}
                  data-testid="modal-secondary-button"
                  {...secondaryButtonProps}
                >
                  {secondaryText}
                </Button>
              )}
              {typeof onTertiary === 'function' && tertiaryText && (
                <Button
                  buttonType={tertiaryButtonType}
                  onClick={onTertiary}
                  className="ml-3"
                  disabled={tertiaryDisabled}
                  {...tertiaryButtonProps}
                >
                  {tertiaryText}
                </Button>
              )}
              {typeof onCancel === 'function' && (
                <Button
                  buttonType={cancelButtonType}
                  onClick={onCancel}
                  className="ml-3 sm:ml-0"
                  data-testid="modal-cancel-button"
                  {...cancelButtonProps}
                >
                  {cancelText
                    ? cancelText
                    : intl.formatMessage(globalMessages.cancel)}
                </Button>
              )}
            </div>
          )}
        </Transition>
      </TransitionChild>,
      document.body
    );
  }
);

Modal.displayName = 'Modal';

export default Modal;
