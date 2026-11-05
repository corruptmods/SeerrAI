export enum Permission {
  NONE = 0,
  ADMIN = 2,
  MANAGE_SETTINGS = 4,
  MANAGE_USERS = 8,
  MANAGE_REQUESTS = 16,
  REQUEST = 32,
  VOTE = 64,
  AUTO_APPROVE = 128,
  AUTO_APPROVE_MOVIE = 256,
  AUTO_APPROVE_TV = 512,
  REQUEST_4K = 1024,
  REQUEST_4K_MOVIE = 2048,
  REQUEST_4K_TV = 4096,
  REQUEST_ADVANCED = 8192,
  REQUEST_VIEW = 16384,
  AUTO_APPROVE_4K = 32768,
  AUTO_APPROVE_4K_MOVIE = 65536,
  AUTO_APPROVE_4K_TV = 131072,
  REQUEST_MOVIE = 262144,
  REQUEST_TV = 524288,
  MANAGE_ISSUES = 1048576,
  VIEW_ISSUES = 2097152,
  CREATE_ISSUES = 4194304,
  AUTO_REQUEST = 8388608,
  AUTO_REQUEST_MOVIE = 16777216,
  AUTO_REQUEST_TV = 33554432,
  RECENT_VIEW = 67108864,
  WATCHLIST_VIEW = 134217728,
  MANAGE_BLOCKLIST = 268435456,
  REQUEST_MUSIC = 536870912,
  VIEW_BLOCKLIST = 1073741824,
  /**
   * 2^31: beyond a 32-bit `&`, so permissions are tested arithmetically, not
   * bitwise, and stored as a bigint.
   */
  AUTO_APPROVE_MUSIC = 2147483648,
}

/** The single bits making up a permission value. */
const bitsOf = (value: number): number[] => {
  const bits: number[] = [];
  let rest = value;
  for (let bit = 1; rest > 0; bit *= 2) {
    if (Math.floor(rest / bit) % 2 === 1) {
      bits.push(bit);
      rest -= bit;
    }
  }
  return bits;
};

/**
 * Whether a permission (any of its bits, for a multi-bit one) is set in a
 * value. Arithmetic, not `&`: JavaScript's bitwise operators are 32-bit and
 * lose 2^31 and above (and with them Auto-Approve Music).
 */
const holds = (value: number, permission: number): boolean =>
  bitsOf(permission).some((bit) => Math.floor(value / bit) % 2 === 1);

export interface PermissionCheckOptions {
  type: 'and' | 'or';
}

/**
 * Whether a permission value grants the given permission(s). Admin always
 * passes.
 *
 * @param options 'and' (default) or 'or' for arrays
 */
export const hasPermission = (
  permissions: Permission | Permission[],
  value: number,
  options: PermissionCheckOptions = { type: 'and' }
): boolean => {
  let total = 0;

  if (permissions === 0) {
    return true;
  }

  if (Array.isArray(permissions)) {
    if (holds(value, Permission.ADMIN)) {
      return true;
    }
    switch (options.type) {
      case 'and':
        return permissions.every((permission) => holds(value, permission));
      case 'or':
        return permissions.some((permission) => holds(value, permission));
    }
  } else {
    total = permissions;
  }

  return holds(value, Permission.ADMIN) || holds(value, total);
};
