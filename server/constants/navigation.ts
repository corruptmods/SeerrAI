// Sidebar and phone menu items by stable names, in default order. Both share
// one order, so the menu editor lists exactly what both show; the first shown
// fill the phone's bottom bar (NAV_BAR_SIZE). Users can reorder and hide items
// (Discover, Customize), saved in their user settings. An item added later
// takes its default place in older saved orders and is shown, so nobody has to
// re-save to see it.
export const NAV_ITEMS = [
  // The phone bar's original five.
  'discover',
  'movies',
  'series',
  'lists',
  'requests',
  // Shown once Lidarr is set up, to users with music on. After the bar's five,
  // so the bar is unchanged.
  'music',
  'calendar',
  'blocklist',
  'issues',
  'users',
  'backfill',
  'settings',
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

// Items nobody can hide. Discover is where the menu is arranged, and on a phone
// the menu is the only way back to it, so hiding it could make everything
// unrecoverable. Settings stays for whoever can see it. Everything else can be
// re-shown from Discover.
export const NAV_ALWAYS_SHOWN: readonly NavItem[] = ['discover', 'settings'];

export const isNavItem = (value: unknown): value is NavItem =>
  NAV_ITEMS.includes(value as NavItem);

export const canHideNavItem = (id: NavItem): boolean =>
  !NAV_ALWAYS_SHOWN.includes(id);

/** A saved order: its known items, each once. Undefined for non-arrays. */
export const cleanNavOrder = (value: unknown): NavItem[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter(isNavItem))] : undefined;

/**
 * Saved hidden items: known, hideable items, each once. Undefined for
 * non-arrays.
 */
export const cleanNavHidden = (value: unknown): NavItem[] | undefined =>
  cleanNavOrder(value)?.filter(canHideNavItem);

/**
 * Every item in the saved order. An item the order omits goes right after its
 * default predecessor (or first). Unknown names are skipped.
 */
export const orderNavItems = (
  saved: readonly string[] | undefined
): NavItem[] => {
  const order = cleanNavOrder(saved ?? []) ?? [];

  NAV_ITEMS.forEach((item, index) => {
    if (order.includes(item)) {
      return;
    }
    const before = NAV_ITEMS.slice(0, index)
      .reverse()
      .find((earlier) => order.includes(earlier));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, item);
  });

  return order;
};

/** Whether an order is the default, so nothing needs saving. */
export const isDefaultNavOrder = (saved: readonly string[]): boolean =>
  orderNavItems(saved).every((id, index) => NAV_ITEMS[index] === id);

/**
 * The order with one item moved just before or after another. Moving relative
 * to an item rather than a position keeps the move meaningful when items
 * between them are hidden from the user.
 */
export const moveNavItem = (
  order: readonly NavItem[],
  id: NavItem,
  target: NavItem,
  side: 'before' | 'after'
): NavItem[] => {
  if (id === target || !order.includes(id) || !order.includes(target)) {
    return [...order];
  }
  const without = order.filter((item) => item !== id);
  const at = without.indexOf(target) + (side === 'after' ? 1 : 0);
  return [...without.slice(0, at), id, ...without.slice(at)];
};

/** Items (sidebar links, menu links) sorted by the saved order. */
export const sortByNavOrder = <T extends { id: NavItem }>(
  items: readonly T[],
  saved: readonly string[] | undefined
): T[] => {
  const order = orderNavItems(saved);
  return [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
};

/** Items on the phone's bottom bar, before its menu button. */
export const NAV_BAR_SIZE = 5;

/** Items minus the hidden ones. */
export const withoutHiddenNav = <T extends { id: NavItem }>(
  items: readonly T[],
  hidden: readonly string[] | undefined
): T[] =>
  items.filter(
    (item) => !canHideNavItem(item.id) || !(hidden ?? []).includes(item.id)
  );

/**
 * Items in the user's order, split where the phone bar ends: up to and
 * including its last item, and the rest (in the menu behind its button). The
 * bar takes the first shown items; hidden ones take no slot but stay in the
 * first part if before the bar's end, so the order reads the same. When
 * everything shown fits, the rest is empty and there's no menu.
 */
export const splitAtNavBar = <T extends { id: NavItem }>(
  items: readonly T[],
  hidden: readonly string[] | undefined
): [T[], T[]] => {
  const shown = withoutHiddenNav(items, hidden);
  if (shown.length <= NAV_BAR_SIZE) {
    return [[...items], []];
  }
  const end = items.indexOf(shown[NAV_BAR_SIZE - 1]) + 1;
  return [items.slice(0, end), items.slice(end)];
};

/** A user's menu arrangement, as saved in their user settings. */
export interface NavLayout {
  order: readonly string[];
  hidden: readonly string[];
}

/**
 * A saved arrangement ready to edit: every item in order, hidden list cleaned.
 */
export const editableNavLayout = (
  saved: Partial<NavLayout> | undefined
): { order: NavItem[]; hidden: NavItem[] } => ({
  order: orderNavItems(saved?.order),
  hidden: cleanNavHidden(saved?.hidden ?? []) ?? [],
});

/** Whether two arrangements produce the same menu. */
export const sameNavLayout = (a: NavLayout, b: NavLayout): boolean => {
  const x = editableNavLayout(a);
  const y = editableNavLayout(b);
  return (
    x.order.join() === y.order.join() &&
    [...x.hidden].sort().join() === [...y.hidden].sort().join()
  );
};
