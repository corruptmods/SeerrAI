interface PageInfo {
  pages: number;
  page: number;
  results: number;
  pageSize: number;
}

export interface PaginatedResponse {
  pageInfo: PageInfo;
}

/** Keys of T whose values are not functions. */
type NonFunctionPropertyNames<T> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];

/** T without its function properties. */
export type NonFunctionProperties<T> = Pick<T, NonFunctionPropertyNames<T>>;
