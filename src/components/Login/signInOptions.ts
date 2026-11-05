/*
 * "Or sign in with" layout: two equal columns when every label fits in half
 * the width, otherwise one button per row, so no label is cut off.
 */

/**
 * Sign-in option button: fixed height, full column width, label truncates (it
 * is a `truncate` span inside the inner span).
 */
export const OPTION_BUTTON =
  'relative h-10 w-full min-w-0 [&>span]:min-w-0 [&>span]:max-w-full';

/** Room a button needs besides its label: padding, border, icon and gap. */
const BUTTON_EXTRA = '4rem';

/**
 * Label width in character widths; CJK and other wide characters count as two.
 */
export const labelWidth = (label: string): number =>
  [...label].reduce(
    (width, char) =>
      width + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(char) ? 2 : 1),
    0
  );

/**
 * grid-template-columns for these labels: each column is at least half the
 * width or the widest label, capped at 100%, so two fit side by side only
 * when every label does.
 */
export const optionColumns = (labels: string[]): string => {
  const widest = Math.max(0, ...labels.map(labelWidth));
  return `repeat(auto-fit, minmax(min(100%, max(calc(${widest}ch + ${BUTTON_EXTRA}), calc(50% - 0.3rem))), 1fr))`;
};

/**
 * Whether the button at `index` spans a row: the last of an odd count, so the
 * rows above stay paired.
 */
export const spansRow = (index: number, count: number): boolean =>
  count % 2 === 1 && index === count - 1;
