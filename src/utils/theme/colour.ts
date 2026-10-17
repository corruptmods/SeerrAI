/*
 * Colour arithmetic for themes: contrast as WCAG measures it, and a whole
 * accent scale made from one colour someone picks.
 *
 * Scales are made in OKLCH, where equal steps of lightness look equal to the
 * eye whatever the hue, so a picked colour gets steps that sit like the
 * built-in ones. The lightness of each step, and how colourful it is next
 * to the most colourful one, follow Tailwind's own indigo.
 */

export type Rgb = [number, number, number];

export const SCALE_STEPS = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;
export type ScaleStep = (typeof SCALE_STEPS)[number];
export type Scale = Record<ScaleStep, string>;

/** Dark text for light colours: the darkest Classic grey. */
export const DARK_INK = '#111827';

/** Every surface text sits on, in every dark background and in light. */
const DARK_SURFACES = [
  '#111827',
  '#1f2937',
  '#000000',
  '#141414',
  '#0f172a',
  '#1e293b',
  '#1c1917',
  '#292524',
];
const LIGHT_SURFACES = ['#ffffff', '#f3f4f6'];

export const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export const rgbToHex = (rgb: Rgb): string =>
  `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

const toLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const fromLinear = (value: number): number =>
  255 *
  (value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055);

const luminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two '#rrggbb' colours, 1 to 21. */
export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/**
 * Text for a colour: white when it is readable on it (4.5:1), otherwise
 * dark, otherwise black. One of white and black always reaches 4.5:1.
 */
export const pickInk = (fill: string): string =>
  ['#ffffff', DARK_INK, '#000000'].find(
    (ink) => contrastRatio(ink, fill) >= 4.5
  ) ?? '#000000';

export interface Oklch {
  l: number;
  c: number;
  /** Degrees. */
  h: number;
}

export const toOklch = (rgb: Rgb): Oklch => {
  const [r, g, b] = rgb.map(toLinear);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, bb), h: h < 0 ? h + 360 : h };
};

/** Linear sRGB, possibly outside 0–1 when the colour can't be shown. */
const oklchToLinear = ({ l, c, h }: Oklch): [number, number, number] => {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
};

export const fromOklch = (colour: Oklch): Rgb =>
  oklchToLinear(colour).map((value) =>
    fromLinear(Math.max(0, Math.min(1, value)))
  ) as Rgb;

const inGamut = (colour: Oklch): boolean =>
  oklchToLinear(colour).every((value) => value >= -1e-4 && value <= 1 + 1e-4);

/** The colour, made less colourful until a screen can show it. */
const clipped = (colour: Oklch): string => {
  if (inGamut(colour)) {
    return rgbToHex(fromOklch(colour));
  }
  let [low, high] = [0, colour.c];
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (inGamut({ ...colour, c: mid })) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return rgbToHex(fromOklch({ ...colour, c: low }));
};

/** Lightness of each step, and its colourfulness next to step 600's. */
const LADDER: Record<ScaleStep, [number, number]> = {
  50: [0.962, 0.07],
  100: [0.93, 0.13],
  200: [0.87, 0.25],
  300: [0.785, 0.44],
  400: [0.673, 0.69],
  500: [0.585, 0.89],
  600: [0.511, 1],
  700: [0.457, 0.89],
  800: [0.398, 0.74],
  900: [0.359, 0.55],
  950: [0.257, 0.34],
};

/**
 * A 50–950 scale with the colour at the step whose lightness is nearest
 * its own, exactly as given; the other steps share its hue.
 */
export const accentScale = (
  hex: string
): { scale: Scale; anchor: ScaleStep } => {
  const colour = toOklch(hexToRgb(hex));
  const anchor = SCALE_STEPS.reduce((best, step) =>
    Math.abs(LADDER[step][0] - colour.l) < Math.abs(LADDER[best][0] - colour.l)
      ? step
      : best
  );
  const peak = colour.c / LADDER[anchor][1];
  const scale = Object.fromEntries(
    SCALE_STEPS.map((step) => [
      step,
      step === anchor
        ? hex
        : clipped({
            l: LADDER[step][0],
            c: peak * LADDER[step][1],
            h: colour.h,
          }),
    ])
  ) as Scale;
  return { scale, anchor };
};

/** The same scale turned round the colour wheel, for gradients. */
export const turnedScale = (scale: Scale, degrees: number): Scale =>
  Object.fromEntries(
    SCALE_STEPS.map((step) => {
      const colour = toOklch(hexToRgb(scale[step]));
      return [step, clipped({ ...colour, h: (colour.h + degrees) % 360 })];
    })
  ) as Scale;

/** What an accent needs in one mode. */
export interface AccentModeColours {
  /** The fill on hover: a neighbour of the fill the button text still reads on. */
  hover: string;
  /** Links and highlights on the page: at least 4.5:1 on every surface. */
  text: string;
  /** A tint behind highlighted things, used see-through. */
  soft: string;
  /** The gradient partner of the fill, and of its hover. */
  alt: string;
  altHover: string;
  /** Small labels in the accent (badges), and their text. */
  chip: string;
  onChip: string;
}

export interface AccentColours {
  scale: Scale;
  /** The scale turned a little, for gradients with the accent. */
  alt: Scale;
  /** Buttons and switches. */
  fill: string;
  fillStep: ScaleStep;
  /** Text on the fill. */
  ink: string;
  /** The text on buttons had to be dark to stay readable. */
  inkIsDark: boolean;
  dark: AccentModeColours;
  light: AccentModeColours;
}

const stepIndex = (step: ScaleStep) => SCALE_STEPS.indexOf(step);

/** Steps from the fill outwards, towards light (-1) or dark (+1). */
const stepsFrom = (step: ScaleStep, direction: -1 | 1): ScaleStep[] => {
  const steps =
    direction < 0
      ? SCALE_STEPS.slice(0, stepIndex(step) + 1).reverse()
      : SCALE_STEPS.slice(stepIndex(step));
  return [...steps];
};

const readableOn = (hex: string, surfaces: string[]) =>
  surfaces.every((surface) => contrastRatio(hex, surface) >= 4.5);

/**
 * One mode's colours, from a scale and the step the fill is at. Hover goes
 * lighter in dark mode and darker in light, unless that would leave the
 * button text unreadable, when it goes the other way. Text is the step
 * nearest the fill that reads on every surface of that mode.
 */
export const accentModeColours = (
  scale: Scale,
  alt: Scale,
  fillStep: ScaleStep,
  ink: string,
  mode: 'dark' | 'light'
): AccentModeColours => {
  const index = stepIndex(fillStep);
  const towards = mode === 'dark' ? -1 : 1;
  const hoverStep =
    [SCALE_STEPS[index + towards], SCALE_STEPS[index - towards]].find(
      (step) => step && contrastRatio(ink, scale[step]) >= 4.5
    ) ?? fillStep;
  const surfaces = mode === 'dark' ? DARK_SURFACES : LIGHT_SURFACES;
  const textStep =
    stepsFrom(fillStep, towards).find((step) =>
      readableOn(scale[step], surfaces)
    ) ?? (mode === 'dark' ? 50 : 950);
  return {
    hover: scale[hoverStep],
    text: scale[textStep],
    soft: scale[mode === 'dark' ? textStep : fillStep],
    alt: alt[fillStep],
    altHover: alt[hoverStep],
    chip: scale[fillStep],
    onChip: ink,
  };
};

/** How far round the colour wheel the gradient partner sits. */
const ALT_TURN = 30;

/**
 * An accent from one colour: the colour fills buttons as it is, with text
 * on it chosen to stay readable (inkIsDark says when that meant dark text).
 */
export const accentFromColour = (hex: string): AccentColours => {
  const { scale, anchor } = accentScale(hex);
  const alt = turnedScale(scale, ALT_TURN);
  const ink = pickInk(hex);
  return {
    scale,
    alt,
    fill: hex,
    fillStep: anchor,
    ink,
    inkIsDark: ink !== '#ffffff',
    dark: accentModeColours(scale, alt, anchor, ink, 'dark'),
    light: accentModeColours(scale, alt, anchor, ink, 'light'),
  };
};

/** A built-in accent from a known scale, the fill at one of its steps. */
export const accentFromScale = (
  scale: Scale,
  fillStep: ScaleStep,
  alt: Scale = turnedScale(scale, ALT_TURN)
): AccentColours => {
  const fill = scale[fillStep];
  const ink = pickInk(fill);
  return {
    scale,
    alt,
    fill,
    fillStep,
    ink,
    inkIsDark: ink !== '#ffffff',
    dark: accentModeColours(scale, alt, fillStep, ink, 'dark'),
    light: accentModeColours(scale, alt, fillStep, ink, 'light'),
  };
};
