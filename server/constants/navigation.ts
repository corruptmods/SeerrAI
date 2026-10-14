/*
 * The items of the sidebar and the phone menu, by names that never change,
 * in their default order. The sidebar and the phone use the same order, so
 * the menu editor lists exactly what both show; the first ones shown go on
 * the bar along the bottom of a phone (NAV_BAR_SIZE). Each person can put
 * them in their own order and hide the ones they don't want (Discover,
 * Customize), kept in their user settings. An item added here later takes
 * its default place in any order saved before it existed, and is shown, so
 * nobody has to save again to see it.
 */
export const NAV_ITEMS = [
  // The phone bar's five, as it has always been.
  'discover',
  'movies',
  'series',
  'lists',
  'requests',
  // Shown once Lidarr is set up, to people with music on. After the bar's
  // five, so the bar stays as it was.
  'music',
  'calendar',
  'blocklist',
  'issues',
  'users',
  'backfill',
  'settings',
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

/*
 * Items nobody can hide. Discover is where the sidebar is arranged, and on
 * a phone the menu is the only way back to it, so hiding it could leave no
 * way to show anything again. Settings stays for whoever can see it at all.
 * Everything else can be shown again from Discover.
 */
export const NAV_ALWAYS_SHOWN: readonly NavItem[] = ['discover', 'settings'];

export const isNavItem = (value: unknown): value is NavItem =>
  NAV_ITEMS.includes(value as NavItem);

export const canHideNavItem = (id: NavItem): boolean =>
  !NAV_ALWAYS_SHOWN.includes(id);

/**
 * An order as it is saved: the items it names that are known, each once.
 * Undefined for anything that is not a list.
 */
export const cleanNavOrder = (value: unknown): NavItem[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter(isNavItem))] : undefined;

/**
 * Hidden items as they are saved: known items that can be hidden, each
 * once. Undefined for anything that is not a list.
 */
export const cleanNavHidden = (value: unknown): NavItem[] | undefined =>
  cleanNavOrder(value)?.filter(canHideNavItem);

/**
 * Every item, in the saved order. One the saved order does not name goes
 * straight after the item it follows by default (or first, if it is first
 * by default). Names that are not items are passed over.
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

/** Whether an order is the default one, so there is nothing to keep. */
export const isDefaultNavOrder = (saved: readonly string[]): boolean =>
  orderNavItems(saved).every((id, index) => NAV_ITEMS[index] === id);

/**
 * The order with one item moved just before or after another. Moving
 * relative to an item, rather than to a place, keeps a move meaningful when
 * the items between them are ones the person cannot see.
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

/** Things that are items (sidebar links, menu links), in the saved order. */
export const sortByNavOrder = <T extends { id: NavItem }>(
  items: readonly T[],
  saved: readonly string[] | undefined
): T[] => {
  const order = orderNavItems(saved);
  return [...items].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
};

/**
 * How many items the bar along the bottom of a phone holds, before its menu
 * button.
 */
export const NAV_BAR_SIZE = 5;

/** Things that are items, without those someone hid. */
export const withoutHiddenNav = <T extends { id: NavItem }>(
  items: readonly T[],
  hidden: readonly string[] | undefined
): T[] =>
  items.filter(
    (item) => !canHideNavItem(item.id) || !(hidden ?? []).includes(item.id)
  );

/**
 * Things that are items, in someone's order, split where the phone's bar
 * ends: up to and including the last item on the bar, and the rest, which
 * are in the menu behind its button. The bar takes the first items shown;
 * a hidden one takes no place on it, and one before the bar's end stays in
 * the first part, so the order reads the same. When everything shown fits
 * on the bar, there is no menu, and the rest is empty.
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

/** How someone arranged their menu, as saved in their user settings. */
export interface NavLayout {
  order: readonly string[];
  hidden: readonly string[];
}

/** A saved arrangement ready to edit: every item in order, hidden cleaned. */
export const editableNavLayout = (
  saved: Partial<NavLayout> | undefined
): { order: NavItem[]; hidden: NavItem[] } => ({
  order: orderNavItems(saved?.order),
  hidden: cleanNavHidden(saved?.hidden ?? []) ?? [],
});

/** Whether two arrangements give the same menu. */
export const sameNavLayout = (a: NavLayout, b: NavLayout): boolean => {
  const x = editableNavLayout(a);
  const y = editableNavLayout(b);
  return (
    x.order.join() === y.order.join() &&
    [...x.hidden].sort().join() === [...y.hidden].sort().join()
  );
};
