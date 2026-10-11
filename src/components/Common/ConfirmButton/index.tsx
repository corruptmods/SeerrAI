import Button from '@app/components/Common/Button';
import useClickOutside from '@app/hooks/useClickOutside';
import { forwardRef, useRef, useState } from 'react';

interface ConfirmButtonProps {
  onClick: () => void;
  confirmText: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

const ConfirmButton = forwardRef<HTMLButtonElement, ConfirmButtonProps>(
  ({ onClick, children, confirmText, className }, parentRef) => {
    const ref = useRef(null);
    useClickOutside(ref, () => setIsClicked(false));
    const [isClicked, setIsClicked] = useState(false);
    return (
      <Button
        ref={parentRef}
        buttonType="danger"
        className={`relative overflow-hidden ${className}`}
        onClick={(e) => {
          e.preventDefault();

          if (!isClicked) {
            setIsClicked(true);
          } else {
            onClick();
          }
        }}
      >
        {/* Both labels share one grid cell, so the button is as wide as
            the longer of them and neither is cut off. */}
        <span ref={ref} className="grid h-full w-full">
          <span
            className={`col-start-1 row-start-1 flex transform-gpu items-center justify-center transition duration-300 ${
              isClicked
                ? '-translate-y-full opacity-0'
                : 'translate-y-0 opacity-100'
            }`}
          >
            {children}
          </span>
          <span
            aria-hidden={!isClicked}
            className={`col-start-1 row-start-1 flex transform-gpu items-center justify-center whitespace-nowrap transition duration-300 ${
              isClicked
                ? 'translate-y-0 opacity-100'
                : 'translate-y-full opacity-0'
            }`}
          >
            {confirmText}
          </span>
        </span>
      </Button>
    );
  }
);

ConfirmButton.displayName = 'ConfirmButton';

export default ConfirmButton;
