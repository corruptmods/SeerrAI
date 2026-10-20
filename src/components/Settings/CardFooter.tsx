import Link from 'next/link';

/*
 * The buttons along the bottom of a settings card (Edit, Make Primary,
 * Remove…), side by side with a line between them. Each has its icon
 * beside its label where the card has room, and over it where it hasn't,
 * and a label too long for its button wraps, centred: in German or French
 * nothing runs into the next button or gets cut off. Which it is depends
 * on the card's width, so cards side by side look alike.
 */

export interface CardFooterAction {
  /** What the button says. */
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  /** A page to open instead of something to do. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Shown on hovering, as why it is disabled. */
  title?: string;
}

interface CardFooterProps {
  actions: CardFooterAction[];
  /**
   * How many buttons cards like this can have: icons go beside their
   * labels once each of that many buttons would have 10rem.
   */
  room: 2 | 3;
}

// Written out whole: Tailwind only builds the classes it finds in full.
// Over its icon, a label is a little smaller, as in a tab bar, so that
// long words (Russian, Finnish…) still fit a narrow button.
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
