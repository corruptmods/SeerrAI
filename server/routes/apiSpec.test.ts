import express from 'express';
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

/*
 * Every API route the app registers must be declared in seerr-api.yml. The
 * OpenAPI validator runs before the routers and answers an undeclared path
 * with "not found", so a route missing from the spec is a feature that
 * silently does nothing (see docs/FORK.md, rule 1). This records the routes
 * exactly as the app registers them, rather than reading the source, so a new
 * router or mount point cannot slip past.
 */

interface Recorded {
  routes: { path: string; methods: string[] }[];
  mounts: { path: string; child: unknown }[];
}

const records = new WeakMap<object, Recorded>();
const recordFor = (router: object): Recorded => {
  let r = records.get(router);
  if (!r) {
    r = { routes: [], mounts: [] };
    records.set(router, r);
  }
  return r;
};

type Proto = {
  use: (...args: unknown[]) => unknown;
  route: (path: string) => { methods: Record<string, boolean> };
};

const proto = (express.Router as unknown as { prototype: Proto }).prototype;
const originalUse = proto.use;
const originalRoute = proto.route;

proto.route = function (this: object, routePath: string) {
  const route = originalRoute.call(this, routePath);
  // Methods are added to the route after this returns; read them later.
  recordFor(this).routes.push({
    path: routePath,
    get methods() {
      return Object.keys(route.methods).filter((m) => m !== '_all');
    },
  });
  return route;
};

proto.use = function (this: object, ...args: unknown[]) {
  const mountPath =
    typeof args[0] === 'string' || Array.isArray(args[0])
      ? (args[0] as string | string[])
      : '/';
  const handlers = args.flat(Infinity).filter((a) => typeof a === 'function');
  for (const handler of handlers) {
    if (Array.isArray((handler as { stack?: unknown }).stack)) {
      for (const p of Array.isArray(mountPath) ? mountPath : [mountPath]) {
        recordFor(this).mounts.push({ path: p, child: handler });
      }
    }
  }
  return originalUse.apply(this, args);
};

const join = (a: string, b: string) =>
  `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`.replace(/\/$/, '') || '/';

/** "/user/:id/settings" and "/user/{userId}/settings" compare equal. */
const shape = (p: string) =>
  p
    .replace(/:\w+/g, '{}')
    .replace(/\{\w+\}/g, '{}')
    .replace(/\/$/, '') || '/';

const collect = (
  router: object,
  prefix: string,
  out: Map<string, Set<string>>,
  seen = new Set<object>()
) => {
  if (seen.has(router)) return;
  seen.add(router);
  const r = records.get(router);
  if (!r) return;
  for (const route of r.routes) {
    const key = shape(join(prefix, route.path));
    const methods = out.get(key) ?? new Set<string>();
    route.methods.forEach((m) => methods.add(m));
    out.set(key, methods);
  }
  for (const mount of r.mounts) {
    collect(mount.child as object, join(prefix, mount.path), out, seen);
  }
};

describe('API spec', () => {
  const registered = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();

  before(async () => {
    const routes = (await import('@server/routes')).default;
    collect(routes, '/', registered);

    const spec = yaml.load(
      readFileSync(path.join(__dirname, '../../seerr-api.yml'), 'utf8')
    ) as { paths: Record<string, Record<string, unknown>> };
    for (const [p, ops] of Object.entries(spec.paths)) {
      const methods = Object.keys(ops).filter((m) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(m)
      );
      declared.set(shape(p), new Set(methods));
    }
  });

  it('finds the app routes to check', () => {
    // Guards the check itself: if recording broke, it would pass vacuously.
    assert.ok(registered.size > 150, `only ${registered.size} routes found`);
    assert.ok(registered.has('/auth/passkey/login'));
    assert.ok(registered.has('/user/{}/settings/features'));
  });

  it('declares every route the app serves', () => {
    const missing: string[] = [];
    for (const [p, methods] of registered) {
      for (const m of methods) {
        if (!declared.get(p)?.has(m)) {
          missing.push(`${m.toUpperCase()} ${p}`);
        }
      }
    }
    assert.deepEqual(
      missing.sort(),
      [],
      'Add these to seerr-api.yml, or the validator answers them "not found"'
    );
  });
});
