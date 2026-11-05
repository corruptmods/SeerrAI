export type Undefinable<T> = T | undefined;
export type Nullable<T> = T | null;

/** Attaches typed properties to an object (e.g. subcomponents at export). */
export function withProperties<A extends object, B extends object>(
  component: A,
  properties: B
): A & B {
  (Object.keys(properties) as (keyof B)[]).forEach((key) => {
    Object.assign(component, { [key]: properties[key] });
  });
  return component as A & B;
}
