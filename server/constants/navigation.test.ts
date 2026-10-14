import {
  NAV_ALWAYS_SHOWN,
  NAV_BAR_SIZE,
  NAV_ITEMS,
  canHideNavItem,
  cleanNavHidden,
  cleanNavOrder,
  editableNavLayout,
  isDefaultNavOrder,
  moveNavItem,
  orderNavItems,
  sameNavLayout,
  sortByNavOrder,
  splitAtNavBar,
  withoutHiddenNav,
} from '@server/constants/navigation';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* How each person arranges their sidebar and phone menu (Discover, Customize). */

describe('a sidebar order', () => {
  it('starts with what the phone bar has always shown', () => {
    // One usual order for the sidebar and the phone. Its first five are
    // the phone bar of 1.1.0, so nobody's bar changes; the sidebar's only
    // change is Watch Lists moving up after Series. Music came after.
    assert.deepEqual(
      [...NAV_ITEMS],
      [
        'discover',
        'movies',
        'series',
        'lists',
        'requests',
        'music',
        'calendar',
        'blocklist',
        'issues',
        'users',
        'backfill',
        'settings',
      ]
    );
  });

  it('is the default order until one is saved', () => {
    assert.deepEqual(orderNavItems(undefined), [...NAV_ITEMS]);
    assert.deepEqual(orderNavItems([]), [...NAV_ITEMS]);
  });

  it('follows a saved order', () => {
    const reversed = [...NAV_ITEMS].reverse();
    assert.deepEqual(orderNavItems(reversed), reversed);
  });

  it('puts an item the saved order does not name in its default place', () => {
    // Saved before Music, Calendar and Backfill existed, with Requests
    // moved first.
    const saved = NAV_ITEMS.filter(
      (id) => !['music', 'calendar', 'backfill', 'requests'].includes(id)
    );
    const order = orderNavItems(['requests', ...saved]);
    assert.equal(order.length, NAV_ITEMS.length);
    // Music follows Requests by default, wherever Requests now is, and
    // Calendar follows Music.
    assert.deepEqual(order.slice(0, 3), ['requests', 'music', 'calendar']);
    assert.equal(order.indexOf('backfill'), order.indexOf('users') + 1);
  });

  it('gives Music its place after Requests in an order saved before it', () => {
    const saved = NAV_ITEMS.filter((id) => id !== 'music').reverse();
    const order = orderNavItems(saved);
    assert.equal(order.indexOf('music'), order.indexOf('requests') + 1);
    assert.equal(canHideNavItem('music'), true);
  });

  it('puts a new first item first', () => {
    const order = orderNavItems(['settings', 'lists']);
    assert.equal(order[0], 'discover');
    assert.equal(order.indexOf('lists'), order.indexOf('settings') + 1);
  });

  it('passes over names it does not know, and repeats', () => {
    // A name from a later version (or an earlier one) is no item here.
    assert.deepEqual(
      orderNavItems(['books', 'settings', 'settings', ...NAV_ITEMS]),
      ['settings', ...NAV_ITEMS.filter((id) => id !== 'settings')]
    );
  });

  it('is saved as the items it knows, each once, and only as a list', () => {
    assert.deepEqual(
      cleanNavOrder(['lists', 'books', 'lists', 7, 'discover']),
      ['lists', 'discover']
    );
    assert.deepEqual(cleanNavOrder([]), []);
    assert.equal(cleanNavOrder('lists'), undefined);
    assert.equal(cleanNavOrder(undefined), undefined);
  });

  it('knows the default order when it sees it', () => {
    assert.equal(isDefaultNavOrder([...NAV_ITEMS]), true);
    assert.equal(isDefaultNavOrder([]), true);
    assert.equal(isDefaultNavOrder(['discover', 'movies']), true);
    assert.equal(isDefaultNavOrder(['movies', 'discover']), false);
  });
});

describe('moving an item', () => {
  const order = [...NAV_ITEMS];

  it('puts it before or after another', () => {
    const before = moveNavItem(order, 'lists', 'discover', 'before');
    assert.deepEqual(before.slice(0, 2), ['lists', 'discover']);
    assert.equal(before.length, NAV_ITEMS.length);

    const after = moveNavItem(order, 'discover', 'settings', 'after');
    assert.equal(after.at(-1), 'discover');
    assert.equal(after[0], 'movies');
  });

  it('moves past an item someone cannot see, so it really moves', () => {
    // Someone without Users or Backfill sees Issues then Settings; moving
    // Settings up puts it before Issues, not between Users and Backfill.
    const moved = moveNavItem(order, 'settings', 'issues', 'before');
    assert.equal(moved.indexOf('settings'), moved.indexOf('issues') - 1);
  });

  it('leaves the order alone for an item it does not know', () => {
    assert.deepEqual(
      moveNavItem(order, 'books' as never, 'discover', 'before'),
      order
    );
    assert.deepEqual(
      moveNavItem(order, 'lists', 'lists', 'after'),
      order,
      'onto itself'
    );
  });
});

describe('hiding items', () => {
  it('never hides Discover or Settings', () => {
    assert.deepEqual([...NAV_ALWAYS_SHOWN].sort(), ['discover', 'settings']);
    assert.equal(canHideNavItem('discover'), false);
    assert.equal(canHideNavItem('settings'), false);
    assert.equal(canHideNavItem('lists'), true);
  });

  it('keeps the items it knows that can be hidden, each once', () => {
    assert.deepEqual(
      cleanNavHidden(['issues', 'settings', 'books', 'issues', 3, 'discover']),
      ['issues']
    );
    assert.equal(cleanNavHidden('issues'), undefined);
  });

  it('leaves out what someone hid, but never Discover or Settings', () => {
    const links = NAV_ITEMS.map((id) => ({ id }));
    assert.deepEqual(
      withoutHiddenNav(links, ['blocklist', 'settings', 'books']).map(
        (link) => link.id
      ),
      NAV_ITEMS.filter((id) => id !== 'blocklist')
    );
    assert.equal(withoutHiddenNav(links, undefined).length, NAV_ITEMS.length);
  });
});

describe('the menus', () => {
  it('put their links in the saved order, the ones someone cannot see keeping their place', () => {
    // Someone who cannot see Users or Settings gets the rest in order.
    const links = [
      { id: 'discover' as const },
      { id: 'requests' as const },
      { id: 'lists' as const },
    ];
    assert.deepEqual(
      sortByNavOrder(links, ['settings', 'lists', 'users', 'discover']).map(
        (link) => link.id
      ),
      // Requests is not named, so it follows Watch Lists, as by default.
      ['lists', 'requests', 'discover']
    );
  });
});

describe('arranging the menu', () => {
  it('starts from what someone saved, every item in place', () => {
    assert.deepEqual(editableNavLayout(undefined), {
      order: [...NAV_ITEMS],
      hidden: [],
    });
    const listsFirst = ['lists', ...NAV_ITEMS.filter((id) => id !== 'lists')];
    const layout = editableNavLayout({
      // Saved before Backfill existed.
      order: listsFirst.filter((id) => id !== 'backfill'),
      hidden: ['issues', 'settings', 'books'],
    });
    assert.deepEqual(layout.order, listsFirst);
    assert.deepEqual(layout.hidden, ['issues']);
  });

  it('counts as unchanged when it comes to the same menu', () => {
    const saved = { order: [], hidden: ['blocklist', 'issues'] };
    // The default order in full is no order; hidden items in any order.
    assert.equal(
      sameNavLayout(saved, {
        order: [...NAV_ITEMS],
        hidden: ['issues', 'blocklist'],
      }),
      true
    );
    assert.equal(
      sameNavLayout(saved, { order: [...NAV_ITEMS], hidden: ['issues'] }),
      false
    );
    assert.equal(
      sameNavLayout(saved, {
        order: moveNavItem(NAV_ITEMS, 'lists', 'discover', 'before'),
        hidden: ['blocklist', 'issues'],
      }),
      false
    );
  });
});

describe('the bar along the bottom of a phone', () => {
  const links = (ids: readonly string[]) =>
    orderNavItems(ids).map((id) => ({ id }));
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  const bar = (items: { id: (typeof NAV_ITEMS)[number] }[], hidden: string[]) =>
    ids(withoutHiddenNav(splitAtNavBar(items, hidden)[0], hidden));

  it('holds five items before its menu button', () => {
    assert.equal(NAV_BAR_SIZE, 5);
  });

  it('shows what it always has to someone who never arranged their menu', () => {
    assert.deepEqual(bar(links([]), []), [
      'discover',
      'movies',
      'series',
      'lists',
      'requests',
    ]);
  });

  it('takes the first items of the order the menu editor lists', () => {
    // Watch Lists moved up one: the bar changes just as the list does.
    const order = moveNavItem(NAV_ITEMS, 'lists', 'series', 'before');
    assert.deepEqual(bar(links(order), []), ids(links(order)).slice(0, 5));
    assert.deepEqual(bar(links(order), []), [
      'discover',
      'movies',
      'lists',
      'series',
      'requests',
    ]);
  });

  it('gives no place to an item someone hid', () => {
    assert.deepEqual(bar(links([]), ['lists', 'movies']), [
      'discover',
      'series',
      'requests',
      'music',
      'calendar',
    ]);
  });

  it('gives no place to an item someone cannot use', () => {
    // Music and Calendar switched off, no Blocklist or Issues permission.
    const usable = links([]).filter(
      (link) =>
        !['requests', 'music', 'calendar', 'blocklist'].includes(link.id)
    );
    assert.deepEqual(bar(usable, ['lists']), [
      'discover',
      'movies',
      'series',
      'issues',
      'users',
    ]);
  });

  it('splits the order where the bar ends, hidden items keeping their place', () => {
    const [onBar, rest] = splitAtNavBar(links([]), ['series']);
    // Series is hidden but stays where it is in the order.
    assert.deepEqual(ids(onBar), [
      'discover',
      'movies',
      'series',
      'lists',
      'requests',
      'music',
    ]);
    assert.deepEqual(ids(rest), NAV_ITEMS.slice(6));
  });

  it('has no menu after it when everything shown fits on it', () => {
    // Four items shown, two more hidden after them: all on the bar.
    const usable = links([]).filter((link) =>
      [
        'discover',
        'movies',
        'series',
        'lists',
        'requests',
        'settings',
      ].includes(link.id)
    );
    const [onBar, rest] = splitAtNavBar(usable, ['requests', 'lists']);
    assert.deepEqual(ids(onBar), ids(usable));
    assert.deepEqual(rest, []);
  });

  it('has a menu after it when one more item is shown', () => {
    const usable = links([]).slice(0, 6);
    const [onBar, rest] = splitAtNavBar(usable, []);
    assert.equal(onBar.length, 5);
    assert.deepEqual(ids(rest), ['music']);
  });
});
