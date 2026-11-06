import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { THEME_STYLE_ID } from './index';
import {
  CSS_PREVIEW_ID,
  PERSONAL_CSS_ID,
  SAFE_MODE_KEY,
  SAFE_MODE_SCRIPT,
  SERVER_CSS_ID,
  THEME_SAFE_STYLE_ID,
  customCssLinks,
  previewCustomCss,
} from './safeMode';

/*
 * Safe mode: ?safe drops custom CSS and theme files for the tab until turned
 * off. The script runs against a minimal page of the elements it touches.
 */

interface FakeElement {
  id: string;
  attributes: Map<string, string>;
  removed: boolean;
  parentNode: { removeChild: (element: FakeElement) => void };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
}

const element = (id: string, attributes: Record<string, string> = {}) => {
  const el: FakeElement = {
    id,
    attributes: new Map(Object.entries(attributes)),
    removed: false,
    parentNode: { removeChild: (child) => (child.removed = true) },
    setAttribute: (name, value) => el.attributes.set(name, value),
    getAttribute: (name) => el.attributes.get(name) ?? null,
    removeAttribute: (name) => el.attributes.delete(name),
  };
  return el;
};

/** A server page with custom CSS and a theme file. */
const page = ({
  search = '',
  remembered,
  storageFails = false,
}: {
  search?: string;
  remembered?: string;
  storageFails?: boolean;
}) => {
  const storage = new Map<string, string>(
    remembered ? [[SAFE_MODE_KEY, remembered]] : []
  );
  const elements = [
    element(THEME_STYLE_ID),
    element(THEME_SAFE_STYLE_ID, { media: 'not all' }),
    element(SERVER_CSS_ID),
    element(PERSONAL_CSS_ID),
  ];
  const root = element('');
  const failing = () => {
    throw new Error('blocked');
  };
  const context = {
    URLSearchParams,
    location: { search },
    window: {
      get sessionStorage() {
        return storageFails
          ? { getItem: failing, setItem: failing }
          : {
              getItem: (key: string) => storage.get(key) ?? null,
              setItem: (key: string, value: string) => storage.set(key, value),
            };
      },
    },
    document: {
      documentElement: root,
      getElementById: (id: string) =>
        elements.find((el) => el.id === id && !el.removed) ?? null,
    },
  };
  vm.runInNewContext(SAFE_MODE_SCRIPT, context);
  const live = (id: string) =>
    elements.find((el) => el.id === id && !el.removed);
  return { storage, root, elements, live };
};

describe('safe mode', () => {
  it('is turned on by ?safe, and the tab remembers it', () => {
    const { storage, root, live, elements } = page({ search: '?safe' });
    assert.equal(storage.get(SAFE_MODE_KEY), 'on');
    assert.equal(root.getAttribute('data-safe'), 'on');
    assert.equal(live(SERVER_CSS_ID), undefined);
    assert.equal(live(PERSONAL_CSS_ID), undefined);
    // The theme-file-free look replaces the theme.
    const theme = live(THEME_STYLE_ID);
    assert.equal(theme, elements[1]);
    assert.equal(theme?.getAttribute('media'), null);
    assert.equal(elements[0].removed, true);
  });

  it('stays on in the tab on any page after', () => {
    const { root, live } = page({ search: '?page=2', remembered: 'on' });
    assert.equal(root.getAttribute('data-safe'), 'on');
    assert.equal(live(SERVER_CSS_ID), undefined);
  });

  it('works for that page even where the browser keeps nothing', () => {
    const { root, live } = page({ search: '?safe=1', storageFails: true });
    assert.equal(root.getAttribute('data-safe'), 'on');
    assert.equal(live(PERSONAL_CSS_ID), undefined);
  });

  it('changes nothing when it is off', () => {
    for (const options of [
      {},
      { search: '?safety=1' },
      { storageFails: true },
    ]) {
      const { root, elements } = page(options);
      assert.equal(root.getAttribute('data-safe'), null);
      assert.ok(elements.every((el) => !el.removed));
      assert.equal(elements[1].getAttribute('media'), 'not all');
    }
  });
});

describe('the custom stylesheets a page loads', () => {
  const settings = (server: string | null, personal: boolean) => ({
    customCss: { server, personal },
  });

  it('are the Server CSS and the person’s own, by version', () => {
    assert.deepEqual(customCssLinks(settings('abc123', true), 'def456'), {
      server: '/api/v1/style/server.css?v=abc123',
      personal: '/api/v1/style/personal.css?v=def456',
    });
  });

  it('leave out what there is none of, or isn’t allowed', () => {
    assert.deepEqual(customCssLinks(settings(null, true), null), {});
    assert.deepEqual(customCssLinks(settings('abc123', false), 'def456'), {
      server: '/api/v1/style/server.css?v=abc123',
    });
    assert.deepEqual(customCssLinks(settings(null, true), undefined), {});
  });
});

describe('custom CSS being edited', () => {
  /** A page's head as a list, with the elements the preview touches. */
  const head = (ids: string[], safe = false) => {
    type Node = {
      id: string;
      tag: string;
      disabled?: boolean;
      textContent?: string;
      after: (node: Node) => void;
      before: (node: Node) => void;
      remove: () => void;
    };
    const nodes: Node[] = [];
    const make = (tag: string, id = ''): Node => {
      const node: Node = {
        id,
        tag,
        after: (other) => nodes.splice(nodes.indexOf(node) + 1, 0, other),
        before: (other) => nodes.splice(nodes.indexOf(node), 0, other),
        remove: () => {
          const at = nodes.indexOf(node);
          if (at >= 0) nodes.splice(at, 1);
        },
      };
      return node;
    };
    ids.forEach((id) => nodes.push(make('link', id)));
    const document = {
      documentElement: { getAttribute: () => (safe ? 'on' : null) },
      getElementById: (id: string) => nodes.find((n) => n.id === id) ?? null,
      createElement: (tag: string) => make(tag),
      head: { appendChild: (node: Node) => nodes.push(node) },
    };
    return { document, nodes };
  };

  const withDocument = (document: object, run: () => void) => {
    const before = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = document;
    try {
      run();
    } finally {
      (globalThis as { document?: unknown }).document = before;
    }
  };

  it('stands in for the saved CSS at its place until put back', () => {
    const page = head([SERVER_CSS_ID, PERSONAL_CSS_ID]);
    withDocument(page.document, () => {
      const putBack = previewCustomCss('server', 'a { color: red }');
      assert.deepEqual(
        page.nodes.map((n) => n.id),
        [SERVER_CSS_ID, CSS_PREVIEW_ID.server, PERSONAL_CSS_ID]
      );
      assert.equal(page.nodes[0].disabled, true);
      assert.equal(page.nodes[1].textContent, 'a { color: red }');

      putBack();
      assert.deepEqual(
        page.nodes.map((n) => n.id),
        [SERVER_CSS_ID, PERSONAL_CSS_ID]
      );
      assert.equal(page.nodes[0].disabled, false);
    });
  });

  it('goes before personal CSS when no Server CSS is saved yet', () => {
    const page = head([PERSONAL_CSS_ID]);
    withDocument(page.document, () => {
      previewCustomCss('server', 'a {}');
      assert.deepEqual(
        page.nodes.map((n) => n.id),
        [CSS_PREVIEW_ID.server, PERSONAL_CSS_ID]
      );
    });
  });

  it('shows nothing in safe mode', () => {
    const page = head([SERVER_CSS_ID], true);
    withDocument(page.document, () => {
      previewCustomCss('server', 'a {}')();
      assert.deepEqual(
        page.nodes.map((n) => n.id),
        [SERVER_CSS_ID]
      );
      assert.equal(page.nodes[0].disabled, undefined);
    });
  });
});
