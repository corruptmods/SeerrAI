import Link from 'next/link';

/*
 * Action buttons along a settings card's bottom edge. Icons sit beside
 * labels when the card is wide enough, above them otherwise; long labels
 * wrap. Layout follows card width, so neighbouring cards match.
 */

export interface CardFooterAction {
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  /** Renders a link instead of a button. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Hover text, e.g. why it is disabled. */
  title?: string;
}

interface CardFooterProps {
  actions: CardFooterAction[];
  /** Max buttons on this card type; icons go beside labels at 10rem each. */
  room: 2 | 3;
}

// Full class names: Tailwind only builds classes it finds whole.
// Stacked labels are smaller so long words fit narrow buttons.
const BUTTON_BESIDE: Record<CardFooterProps['room'], string> = {
  2: 'px-1 py-3 text-xs [@container(min-width:20rem)]:px-2 [@container(min-width:20rem)]:py-4 [@container(min-width:20rem)]:text-sm',
  3: 'px-1 py-3 text-xs [@container(min-width:30rem)]:px-2 [@container(min-width:30rem)]:py-4 [@container(min-width:30rem)]:text-sm',
};
const CONTENT_BESIDE: Record<CardFooterProps['room'], string> = {
  2: 'flex-col gap-1 [@container(min-width:20rem)]:flex-row [@container(min-width:20rem)]:gap-2',
  3: 'flex-col gap-1 [@container(min-width:30rem)]:flex-row [@container(min-width:30rem)]:gap-2',
};

const CardFooter = ({ actions, room }: CardFooterProps) => (
  <div className="flex border-t border-gray-500 [container-type:inline-size]">
    {actions.map((action, index) => {
      const corners =
        actions.length === 1
          ? 'rounded-b-lg'
          : index === 0
            ? 'rounded-bl-lg'
            : index === actions.length - 1
              ? 'rounded-br-lg border-l-gray-500'
              : 'border-l-gray-500';
      const className = `relative flex min-w-0 flex-1 basis-0 items-center justify-center border border-transparent font-medium leading-5 text-gray-200 transition duration-150 ease-in-out hover:text-strong focus:z-10 focus:border-gray-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_BESIDE[room]} ${corners}`;
      const Icon = action.icon;
      const content = (
        <span
          className={`flex w-full min-w-0 items-center justify-center whitespace-normal ${CONTENT_BESIDE[room]}`}
        >
          <Icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 max-w-full break-words text-center">
            {action.label}
          </span>
        </span>
      );
      return action.href ? (
        <Link
          key={action.label}
          href={action.href}
          className={className}
          title={action.title}
        >
          {content}
        </Link>
      ) : (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title}
          className={className}
        >
          {content}
        </button>
      );
    })}
  </div>
);

export default CardFooter;
