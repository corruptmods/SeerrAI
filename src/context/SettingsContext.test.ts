import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, useContext } from 'react';
import { renderToString } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { SettingsContext, SettingsProvider } from './SettingsContext';

const KEY = '/api/v1/settings/public';

const Show = () => {
  const { currentSettings } = useContext(SettingsContext);
  return createElement('span', null, currentSettings.applicationTitle);
};

describe('SettingsProvider', () => {
  it('keeps the settings last loaded when a refresh fails', () => {
    const loaded = { applicationTitle: 'Family Films' };
    const cache = new Map<string, unknown>([
      [KEY, { data: loaded, error: new Error('502 Bad Gateway') }],
    ]);

    const html = renderToString(
      createElement(
        SWRConfig,
        { value: { provider: () => cache as never } },
        createElement(
          SettingsProvider,
          { currentSettings: loaded as never },
          createElement(Show)
        )
      )
    );

    assert.match(html, /Family Films/);
  });
});
