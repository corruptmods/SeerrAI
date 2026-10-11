import React from 'react';
import ReactDOM from 'react-dom';
import type { Config } from 'react-popper-tooltip';
import { usePopperTooltip } from 'react-popper-tooltip';

type TooltipProps = {
  content: React.ReactNode;
  children: React.ReactElement<any>;
  tooltipConfig?: Partial<Config>;
  className?: string;
};

/** Whether anything in these children would be read out as text. */
const hasText = (node: React.ReactNode): boolean => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).trim().length > 0;
  }
  if (Array.isArray(node)) {
    return node.some(hasText);
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return hasText(node.props.children);
  }
  return false;
};

/*
 * A button that is only an icon has no name for a screen reader, and a
 * tooltip is not one. When the tooltip is plain text and the button has no
 * text or label of its own, the tooltip's text names it. Anything with its
 * own text keeps it.
 */
const nameFor = (
  child: React.ReactElement<{
    onClick?: unknown;
    children?: React.ReactNode;
    'aria-label'?: string;
    'aria-labelledby'?: string;
  }>,
  content: React.ReactNode
): string | undefined =>
  typeof content === 'string' &&
  (child.type === 'button' || child.type === 'a' || child.props.onClick) &&
  !child.props['aria-label'] &&
  !child.props['aria-labelledby'] &&
  !hasText(child.props.children)
    ? content
    : undefined;

const Tooltip = ({
  children,
  content,
  tooltipConfig,
  className,
}: TooltipProps) => {
  const { getTooltipProps, setTooltipRef, setTriggerRef, visible } =
    usePopperTooltip({
      followCursor: true,
      offset: [-28, 6],
      placement: 'auto-end',
      ...tooltipConfig,
    });

  const tooltipStyle = [
    'z-50 text-sm absolute font-normal bg-gray-800 px-2 py-1 rounded border border-gray-600 shadow text-gray-100',
  ];

  if (className) {
    tooltipStyle.push(className);
  }

  return (
    <>
      {React.cloneElement(children, {
        ref: setTriggerRef,
        'aria-label':
          nameFor(children, content) ?? children.props['aria-label'],
      })}
      {visible &&
        content &&
        ReactDOM.createPortal(
          <div
            ref={setTooltipRef}
            {...getTooltipProps({
              className: tooltipStyle.join(' '),
            })}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
};

export default Tooltip;
