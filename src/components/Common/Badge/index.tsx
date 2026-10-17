import Link from 'next/link';
import React from 'react';

interface BadgeProps {
  badgeType?:
    | 'default'
    | 'primary'
    | 'danger'
    | 'warning'
    | 'success'
    | 'dark'
    | 'light'
    | 'deep';
  className?: string;
  href?: string;
  children: React.ReactNode;
}

const Badge = (
  { badgeType = 'default', className, href, children }: BadgeProps,
  ref?: React.Ref<HTMLElement>
) => {
  const badgeStyle = [
    'px-2 inline-flex text-xs leading-5 font-semibold rounded-full whitespace-nowrap',
  ];

  if (href) {
    badgeStyle.push('transition cursor-pointer !no-underline');
  } else {
    badgeStyle.push('cursor-default');
  }

  // Theme colours (tailwind.config.js); see Button.
  switch (badgeType) {
    case 'danger':
      badgeStyle.push('bg-danger/fill border-red-500 border !text-red-100');
      if (href) {
        badgeStyle.push('hover:bg-red-500');
      }
      break;
    case 'warning':
      badgeStyle.push(
        'bg-warning/fill border-yellow-500 border !text-yellow-100'
      );
      if (href) {
        badgeStyle.push('hover:bg-yellow-500');
      }
      break;
    case 'success':
      badgeStyle.push(
        'bg-success/fill border border-green-500 !text-green-100'
      );
      if (href) {
        badgeStyle.push('hover:bg-green-500');
      }
      break;
    case 'dark':
      badgeStyle.push('bg-page !text-muted');
      if (href) {
        badgeStyle.push('hover:bg-surface');
      }
      break;
    case 'light':
      badgeStyle.push('bg-surface-raised !text-default');
      if (href) {
        badgeStyle.push('hover:bg-gray-600');
      }
      break;
    case 'deep':
      // The accent's deep shades, as on the page you are on in the sidebar.
      // The text is pale (Indigo's palest shade, as before) rather than the
      // text chosen for its fill, which is dark for a light accent.
      badgeStyle.push(
        'bg-accent-chip/accent-fill border !border-accent bg-gradient-to-br from-indigo-700 to-accent-alt-700 !text-on-accent-deep'
      );
      break;
    default:
      badgeStyle.push(
        'bg-accent-chip/accent-fill border border-accent-chip !text-on-accent-chip'
      );
      if (href) {
        badgeStyle.push('hover:bg-accent-chip');
      }
  }

  if (className) {
    badgeStyle.push(className);
  }

  if (href?.includes('://')) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={badgeStyle.join(' ')}
        data-seerr="badge"
        ref={ref as React.Ref<HTMLAnchorElement>}
      >
        {children}
      </a>
    );
  } else if (href) {
    return (
      <Link
        href={href}
        className={badgeStyle.join(' ')}
        data-seerr="badge"
        ref={ref as React.Ref<HTMLAnchorElement>}
      >
        {children}
      </Link>
    );
  } else {
    return (
      <span
        className={badgeStyle.join(' ')}
        data-seerr="badge"
        ref={ref as React.Ref<HTMLSpanElement>}
      >
        {children}
      </span>
    );
  }
};

export default React.forwardRef(Badge) as typeof Badge;
