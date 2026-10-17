// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultTheme = require('tailwindcss/defaultTheme');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('tailwindcss/plugin');

/*
 * Every colour below reads a CSS variable, so a theme changes them all at
 * once (src/utils/theme). `rgb(var(--x) / <alpha-value>)` keeps opacity
 * modifiers working: bg-surface/80, text-strong/50.
 */
const themed = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const themedScale = (name) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
      step,
      themed(`${name}-${step}`),
    ])
  );
// For plugins that want a plain colour.
const solid = (name) => `rgb(var(--${name}))`;
const status = (name) => ({
  DEFAULT: themed(name),
  text: themed(`${name}-text`),
  soft: themed(`${name}-soft`),
});

/** @type {import('tailwindcss').Config} */
module.exports = {
  mode: 'jit',
  // `dark:` styles (the date picker's, among others) follow the app's own
  // light or dark, not the device's: <html data-mode="dark|light">. Written
  // as a descendant selector, so they outweigh the form styles in
  // globals.css as they did when this was the "dark" class.
  darkMode: ['variant', '[data-mode="dark"] &'],
  content: [
    './node_modules/@seerr-team/react-tailwindcss-datepicker/dist/index.esm.js',
    './src/pages/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/hooks/**/*.{ts,tsx}',
  ],
  theme: {
    // Corners read variables too, for the Square corners choice.
    borderRadius: {
      none: '0px',
      sm: 'var(--radius-sm)',
      DEFAULT: 'var(--radius)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-xl)',
      '2xl': 'var(--radius-2xl)',
      '3xl': 'var(--radius-3xl)',
      full: '9999px',
    },
    extend: {
      colors: {
        // Not yet given a semantic colour, these still follow the theme:
        // gray is the background's greys, indigo the accent's scale.
        gray: themedScale('gray'),
        indigo: themedScale('accent'),

        // Surfaces.
        page: themed('page'),
        surface: {
          DEFAULT: themed('surface'),
          raised: themed('surface-raised'),
        },
        sidebar: { DEFAULT: themed('sidebar'), to: themed('sidebar-to') },
        // Dims the page behind a window, and sits behind text on pictures:
        // dark in every theme.
        overlay: {
          DEFAULT: themed('overlay'),
          strong: themed('overlay-strong'),
        },
        'media-scrim': themed('media-scrim'),
        // Form fields.
        field: { DEFAULT: themed('field'), border: themed('field-border') },

        // Text: strong (headings, values), default (body), muted (hints).
        strong: themed('text-strong'),
        default: themed('text-default'),
        muted: themed('text-muted'),
        'on-accent': themed('on-accent'),
        'on-accent-chip': themed('on-accent-chip'),
        'on-accent-deep': themed('on-accent-deep'),
        'on-media': themed('on-media'),

        // The accent: fill (buttons), hover, text (links), soft (tints),
        // and alt, its partner in gradients.
        accent: {
          DEFAULT: themed('accent'),
          hover: themed('accent-hover'),
          text: themed('accent-text'),
          soft: themed('accent-soft'),
          chip: themed('accent-chip'),
          alt: {
            DEFAULT: themed('accent-alt'),
            hover: themed('accent-alt-hover'),
            ...themedScale('accent-alt'),
          },
        },

        success: status('success'),
        warning: status('warning'),
        danger: status('danger'),
        info: status('info'),
      },
      // Lines: border-subtle (dividers), border-strong (outlines).
      borderColor: {
        subtle: themed('border-subtle'),
        strong: themed('border-strong'),
      },
      ringColor: {
        subtle: themed('border-subtle'),
        strong: themed('border-strong'),
      },
      // How see-through fills, panels and bars are: bg-accent/fill. Solid
      // when someone turns on "Reduce see-through panels".
      opacity: {
        fill: 'var(--fill-opacity)',
        // The accent's own fills: solid when its button text is dark.
        'accent-fill': 'var(--accent-fill-opacity)',
        panel: 'var(--panel-opacity)',
        bar: 'var(--bar-opacity)',
      },
      transitionProperty: {
        'max-height': 'max-height',
        width: 'width',
      },
      fontFamily: {
        sans: ['Inter Variable', ...defaultTheme.fontFamily.sans],
      },
      typography: () => ({
        DEFAULT: {
          css: {
            color: solid('gray-300'),
            a: {
              color: solid('accent-text'),
              '&:hover': {
                color: solid('accent-400'),
              },
            },

            h1: {
              color: solid('gray-300'),
            },
            h2: {
              color: solid('gray-300'),
            },
            h3: {
              color: solid('gray-300'),
            },
            h4: {
              color: solid('gray-300'),
            },
            h5: {
              color: solid('gray-300'),
            },
            h6: {
              color: solid('gray-300'),
            },

            strong: {
              color: solid('gray-400'),
            },

            code: {
              color: solid('gray-300'),
            },

            figcaption: {
              color: solid('gray-500'),
            },
          },
        },
      }),
    },
    aspectRatio: {
      auto: 'auto',
      square: '1 / 1',
      video: '16 / 9',
      1: '1',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
      7: '7',
      8: '8',
      9: '9',
      10: '10',
      11: '11',
      12: '12',
      13: '13',
      14: '14',
      15: '15',
      16: '16',
    },
  },
  plugins: [
    // `light:` for the odd style that needs its own value in light mode.
    plugin(({ addVariant }) => {
      addVariant('light', '[data-mode="light"] &');
    }),
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/aspect-ratio'),
  ],
};
