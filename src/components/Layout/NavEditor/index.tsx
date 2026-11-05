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
  tip: 'Drag or use the arrows to reorder; hide what you don’t use.',
  phoneTip:
    'Drag or use the arrows to reorder; hide what you don’t use. The first {count} go in the bottom bar.',
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

/** A menu item the person can use. */
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

/* One item: dragged by its row, or moved with its arrows. */
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

  // Drag for mouse and touch only; keyboard and screen readers use the arrows.
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

  // Larger buttons side by side on a phone; stacked arrows in the narrow
  // sidebar.
  const buttonBase =
    'rounded hover:text-strong focus:text-strong focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:text-gray-700';
  const arrow = `${buttonBase} text-muted ${phone ? 'p-2' : 'p-0.5'}`;
  const iconSize = phone ? 'h-5 w-5' : 'h-4 w-4';

  return (
    <li
      ref={ref}
      {...dragProps}
      {...dropProps}
      data-testid={`nav-editor-${item.id}`}
      className={`relative flex cursor-grab items-center gap-2 rounded-md border border-subtle bg-surface px-2 ${
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
          hidden ? 'text-gray-600' : 'text-default'
        }`,
      })}
      <span
        className={`min-w-0 flex-1 break-words text-sm font-medium ${
          hidden ? 'text-gray-500 line-through' : 'text-strong'
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
            hidden ? 'text-gray-500' : 'text-indigo-400 light:text-accent-text'
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
  /** Only the items this person can use. */
  items: NavEditorItem[];
  draft: NavDraft;
  onChange: (draft: NavDraft) => void;
  /** In the phone menu: bigger buttons, and a note about the bar. */
  phone?: boolean;
}

/*
 * The sidebar or phone menu while customizing the home page: move or hide
 * each item. Changes stay in the draft, saved or dropped with the home page.
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
  // Buttons to refocus after the menu changes: the first present and enabled.
  const [focusAfter, setFocusAfter] = useState<string[]>();

  const byId = new Map(items.map((item) => [item.id, item]));
  const shown = draft.order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  // On a phone, bar items and menu items, split as the bar itself does.
  const [onBar, inMenu] = phone
    ? splitAtNavBar(shown, draft.hidden)
    : [shown, []];

  // Keyboard moves keep focus on the moved item's arrow, or the other arrow
  // at the top or bottom. On a phone a move between bar and menu remounts
  // the row, so a focused eye button is refocused too.
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

  // Moves past the next visible item, never one outside their menu.
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

  // Rows are numbered from `start` in the whole order, so the arrows know
  // the first and last item across groups.
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
    // In the sidebar, room to scroll the last items clear of the Save bar.
    <div
      className={`space-y-3 ${phone ? '' : 'pb-24'}`}
      data-testid="nav-editor"
    >
      <div>
        <h2 className="text-sm font-semibold text-strong">
          {intl.formatMessage(messages.arrange)}
        </h2>
        <p className="mt-1 text-xs text-muted">
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
              className="text-xs font-semibold text-muted"
            >
              {intl.formatMessage(messages.onBar)}
            </h3>
            {list(onBar, 0, `${groupId}-bar`)}
          </div>
          {inMenu.length > 0 && (
            <div className="space-y-2 border-t border-subtle pt-3">
              <h3
                id={`${groupId}-menu`}
                className="text-xs font-semibold text-muted"
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
        className="flex items-center gap-2 rounded-md border border-strong px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
