import type { NavDraft } from '@app/context/NavLayoutContext';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  Bars3Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  EyeSlashIcon,
  LockClosedIcon,
} from '@heroicons/react/24/solid';
import type { NavItem } from '@server/constants/navigation';
import {
  NAV_BAR_SIZE,
  NAV_ITEMS,
  canHideNavItem,
  moveNavItem,
  splitAtNavBar,
} from '@server/constants/navigation';
import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-aria';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.NavEditor', {
  arrange: 'Arrange your menu',
  tip: 'Drag an item, or use its arrows, to move it. Hide the ones you don’t use.',
  phoneTip:
    'Drag an item, or use its arrows, to move it. Hide the ones you don’t use. The first {count} shown go on the bar at the bottom of the screen.',
  onBar: 'On the bar',
  inMenu: 'In the menu',
  moveUp: 'Move {item} up',
  moveDown: 'Move {item} down',
  show: 'Show {item}',
  alwaysShown: '{item} is always shown',
  moved: '{item} moved to place {place} of {count}.',
  hidden: '{item} hidden.',
  shown: '{item} shown.',
  reset: 'Reset Menu',
  resetDone: 'Menu back to the usual order, with everything shown.',
});

/** An item someone can use, as it appears in their menu. */
export interface NavEditorItem {
  id: NavItem;
  name: string;
  icon: React.ReactElement<{ className?: string }>;
}

const Position = { None: 'None', Above: 'Above', Below: 'Below' } as const;

interface RowProps {
  item: NavEditorItem;
  index: number;
  count: number;
  hidden: boolean;
  phone: boolean;
  onMove: (id: NavItem, by: 'up' | 'down') => void;
  onDrop: (id: NavItem, target: NavItem, side: 'before' | 'after') => void;
  onToggle: (id: NavItem) => void;
  buttonRef: (key: string, button: HTMLButtonElement | null) => void;
}

/* One item: dragged by the row, or moved with its arrows. */
const Row = ({
  item,
  index,
  count,
  hidden,
  phone,
  onMove,
  onDrop,
  onToggle,
  buttonRef,
}: RowProps) => {
  const intl = useIntl();
  const ref = useRef<HTMLLIElement>(null);
  const [hover, setHover] = useState<keyof typeof Position>(Position.None);
  const hideable = canHideNavItem(item.id);

  // Dragging is for a mouse or a touch screen. By keyboard or screen
  // reader the arrows move an item, so the row itself starts no drag.
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ 'nav-item': item.id }],
    hasDragButton: true,
  });
  const { dropProps } = useDrop({
    ref,
    onDropMove: (e) => {
      if (ref.current) {
        setHover(
          e.y < ref.current.offsetHeight / 2 ? Position.Above : Position.Below
        );
      }
    },
    onDropExit: () => setHover(Position.None),
    onDrop: async (e) => {
      const side = hover === Position.Above ? 'before' : 'after';
      setHover(Position.None);
      for (const dropped of e.items) {
        if (dropped.kind === 'text' && dropped.types.has('nav-item')) {
          onDrop((await dropped.getText('nav-item')) as NavItem, item.id, side);
        }
      }
    },
  });

  // Larger buttons side by side on a phone; stacked arrows in the sidebar,
  // where the width is narrow.
  const buttonBase =
    'rounded hover:text-white focus:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:text-gray-700';
  const arrow = `${buttonBase} text-gray-400 ${phone ? 'p-2' : 'p-0.5'}`;
  const iconSize = phone ? 'h-5 w-5' : 'h-4 w-4';

  return (
    <li
      ref={ref}
      {...dragProps}
      {...dropProps}
      data-testid={`nav-editor-${item.id}`}
      className={`relative flex cursor-grab items-center gap-2 rounded-md border border-gray-700 bg-gray-800 px-2 ${
        phone ? 'py-1' : 'py-1.5'
      } ${isDragging ? 'opacity-50' : ''}`}
    >
      {hover === Position.Above && (
        <div className="absolute -top-1.5 left-0 w-full border-t-4 border-indigo-500" />
      )}
      {hover === Position.Below && (
        <div className="absolute -bottom-1.5 left-0 w-full border-t-4 border-indigo-500" />
      )}
      <Bars3Icon
        className="h-5 w-5 flex-shrink-0 text-gray-500"
        aria-hidden="true"
      />
      {cloneElement(item.icon, {
        className: `h-5 w-5 flex-shrink-0 ${
          hidden ? 'text-gray-600' : 'text-gray-300'
        }`,
      })}
      <span
        className={`min-w-0 flex-1 truncate text-sm font-medium ${
          hidden ? 'text-gray-500 line-through' : 'text-white'
        }`}
      >
        {item.name}
      </span>
      <div className={`flex flex-shrink-0 ${phone ? '' : 'flex-col'}`}>
        <button
          type="button"
          ref={(el) => buttonRef(`${item.id}-up`, el)}
          className={arrow}
          aria-label={intl.formatMessage(messages.moveUp, { item: item.name })}
          title={intl.formatMessage(messages.moveUp, { item: item.name })}
          disabled={index === 0}
          onClick={() => onMove(item.id, 'up')}
        >
          <ChevronUpIcon className={iconSize} />
        </button>
        <button
          type="button"
          ref={(el) => buttonRef(`${item.id}-down`, el)}
          className={arrow}
          aria-label={intl.formatMessage(messages.moveDown, {
            item: item.name,
          })}
          title={intl.formatMessage(messages.moveDown, { item: item.name })}
          disabled={index === count - 1}
          onClick={() => onMove(item.id, 'down')}
        >
          <ChevronDownIcon className={iconSize} />
        </button>
      </div>
      {hideable ? (
        <button
          type="button"
          ref={(el) => buttonRef(`${item.id}-show`, el)}
          className={`${buttonBase} flex-shrink-0 ${
            hidden ? 'text-gray-500' : 'text-indigo-400'
          } ${phone ? 'p-2' : 'p-1'}`}
          aria-label={intl.formatMessage(messages.show, { item: item.name })}
          title={intl.formatMessage(messages.show, { item: item.name })}
          aria-pressed={!hidden}
          onClick={() => onToggle(item.id)}
        >
          {hidden ? (
            <EyeSlashIcon className="h-5 w-5" />
          ) : (
            <EyeIcon className="h-5 w-5" />
          )}
        </button>
      ) : (
        <span
          className={`flex-shrink-0 text-gray-600 ${phone ? 'p-2' : 'p-1'}`}
          role="img"
          aria-label={intl.formatMessage(messages.alwaysShown, {
            item: item.name,
          })}
          title={intl.formatMessage(messages.alwaysShown, {
            item: item.name,
          })}
        >
          <LockClosedIcon className="h-5 w-5" />
        </span>
      )}
    </li>
  );
};

interface NavEditorProps {
  /** The items this person can use; the others are not theirs to arrange. */
  items: NavEditorItem[];
  draft: NavDraft;
  onChange: (draft: NavDraft) => void;
  /** In the phone menu: bigger buttons, and a word about the bar. */
  phone?: boolean;
}

/*
 * The sidebar or the phone menu while someone customizes their home page:
 * each item they can use, to move or hide. Changes are kept in the draft,
 * and saved or dropped with the rest of the home page.
 */
const NavEditor = ({
  items,
  draft,
  onChange,
  phone = false,
}: NavEditorProps) => {
  const intl = useIntl();
  const groupId = useId();
  const [announcement, setAnnouncement] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // The buttons to give the focus back to once the menu has changed, the
  // first one there and enabled.
  const [focusAfter, setFocusAfter] = useState<string[]>();

  const byId = new Map(items.map((item) => [item.id, item]));
  const shown = draft.order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  // On a phone, the items on the bar along the bottom, and those in the
  // menu behind its button: the same split the bar itself makes.
  const [onBar, inMenu] = phone
    ? splitAtNavBar(shown, draft.hidden)
    : [shown, []];

  // An arrow pressed by keyboard keeps the focus on the item moved, on the
  // other arrow once it reaches the top or the bottom. On a phone an item
  // can also move between the bar's group and the menu's, which draws its
  // row afresh, so a focused eye button gets the focus back too.
  useEffect(() => {
    if (!focusAfter) {
      return;
    }
    focusAfter
      .map((key) => buttons.current.get(key))
      .find((button) => button && !button.disabled)
      ?.focus();
    setFocusAfter(undefined);
  }, [focusAfter, draft]);

  const place = (id: NavItem, target: NavItem, side: 'before' | 'after') => {
    const order = moveNavItem(draft.order, id, target, side);
    onChange({ ...draft, order });
    const visible = order.filter((item) => byId.has(item));
    const name = byId.get(id)?.name;
    if (name) {
      setAnnouncement(
        intl.formatMessage(messages.moved, {
          item: name,
          place: visible.indexOf(id) + 1,
          count: visible.length,
        })
      );
    }
  };

  // Up and down move past the next item this person can see, so a move is
  // never spent on an item that isn't in their menu.
  const move = (id: NavItem, by: 'up' | 'down') => {
    const index = shown.findIndex((item) => item.id === id);
    const neighbour = shown[by === 'up' ? index - 1 : index + 1];
    if (!neighbour) {
      return;
    }
    place(id, neighbour.id, by === 'up' ? 'before' : 'after');
    setFocusAfter([`${id}-${by}`, `${id}-${by === 'up' ? 'down' : 'up'}`]);
  };

  const toggle = (id: NavItem) => {
    const hiding = !draft.hidden.includes(id);
    if (buttons.current.get(`${id}-show`) === document.activeElement) {
      setFocusAfter([`${id}-show`]);
    }
    onChange({
      ...draft,
      hidden: hiding
        ? [...draft.hidden, id]
        : draft.hidden.filter((item) => item !== id),
    });
    setAnnouncement(
      intl.formatMessage(hiding ? messages.hidden : messages.shown, {
        item: byId.get(id)?.name ?? id,
      })
    );
  };

  // Rows numbered from `start` in the whole order, so the arrows know the
  // first and the last item whichever group they are in.
  const list = (items: NavEditorItem[], start: number, labelledBy?: string) => (
    <ul
      className="space-y-2"
      aria-label={labelledBy ? undefined : intl.formatMessage(messages.arrange)}
      aria-labelledby={labelledBy}
    >
      {items.map((item, index) => (
        <Row
          key={item.id}
          item={item}
          index={start + index}
          count={shown.length}
          hidden={canHideNavItem(item.id) && draft.hidden.includes(item.id)}
          phone={phone}
          onMove={move}
          onDrop={place}
          onToggle={toggle}
          buttonRef={(key, button) => {
            if (button) {
              buttons.current.set(key, button);
            } else {
              buttons.current.delete(key);
            }
          }}
        />
      ))}
    </ul>
  );

  return (
    // In the sidebar, room to scroll the last items clear of Discover's
    // Save bar along the bottom of the screen.
    <div
      className={`space-y-3 ${phone ? '' : 'pb-24'}`}
      data-testid="nav-editor"
    >
      <div>
        <h2 className="text-sm font-semibold text-white">
          {intl.formatMessage(messages.arrange)}
        </h2>
        <p className="mt-1 text-xs text-gray-400">
          {phone
            ? intl.formatMessage(messages.phoneTip, { count: NAV_BAR_SIZE })
            : intl.formatMessage(messages.tip)}
        </p>
      </div>
      {phone ? (
        <>
          <div className="space-y-2">
            <h3
              id={`${groupId}-bar`}
              className="text-xs font-semibold text-gray-400"
            >
              {intl.formatMessage(messages.onBar)}
            </h3>
            {list(onBar, 0, `${groupId}-bar`)}
          </div>
          {inMenu.length > 0 && (
            <div className="space-y-2 border-t border-gray-700 pt-3">
              <h3
                id={`${groupId}-menu`}
                className="text-xs font-semibold text-gray-400"
              >
                {intl.formatMessage(messages.inMenu)}
              </h3>
              {list(inMenu, onBar.length, `${groupId}-menu`)}
            </div>
          )}
        </>
      ) : (
        list(shown, 0)
      )}
      <button
        type="button"
        className="flex items-center gap-2 rounded-md border border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        onClick={() => {
          onChange({ order: [...NAV_ITEMS], hidden: [] });
          setAnnouncement(intl.formatMessage(messages.resetDone));
        }}
      >
        <ArrowPathIcon className="h-4 w-4" />
        <span>{intl.formatMessage(messages.reset)}</span>
      </button>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
};

export default NavEditor;
