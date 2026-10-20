/*
 * The "Or sign in with" buttons on the sign-in page: equal widths in two
 * aligned columns where every label fits in half the width, otherwise one
 * button to a row, so no label is squeezed or cut off.
 */

/**
 * Every sign-in button in the list: one height, as wide as its column, and a label too
 * long for it ends in an ellipsis rather than spilling out. (The label is a
 * `truncate` span inside the button's own inner span.)
 */
export const OPTION_BUTTON =
  'relative h-10 w-full min-w-0 [&>span]:min-w-0 [&>span]:max-w-full';

/** Room a button needs besides its label: padding, border, icon and gap. */
const BUTTON_EXTRA = '4rem';

/**
 * How many character widths a label takes: letters from Chinese, Japanese
 * and Korean scripts (and other wide characters) take about two.
 */
export const labelWidth = (label: string): number =>
  [...label].reduce(
    (width, char) =>
      width + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(char) ? 2 : 1),
    0
  );

/**
 * The columns for buttons with these labels (CSS grid-template-columns):
 * a column is at least half the width, or the widest label's width if
 * that is more, so two fit side by side only when every label does. Never
 * wider than the space there is.
 */
export const optionColumns = (labels: string[]): string => {
  const widest = Math.max(0, ...labels.map(labelWidth));
  return `repeat(auto-fit, minmax(min(100%, max(calc(${widest}ch + ${BUTTON_EXTRA}), calc(50% - 0.3rem))), 1fr))`;
};

/**
 * Whether the button at `index` of `count` takes a whole row: the last of
 * an odd number, so the rows above it stay paired.
 */
export const spansRow = (index: number, count: number): boolean =>
  count % 2 === 1 && index === count - 1;
