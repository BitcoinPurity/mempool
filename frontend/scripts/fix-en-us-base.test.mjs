import test from 'node:test';
import assert from 'node:assert/strict';
import { fixEnglishBaseHref, fixEnglishLocaleConfig } from './fix-en-us-base.mjs';

test('English localized index uses /en-US/ for Angular route and scripts', () => {
  const source = '<html><head><base href="/"><script src="main.abc.js"></script></head></html>';
  assert.match(fixEnglishBaseHref(source), /<base href="\/en-US\/">/);
  assert.match(fixEnglishBaseHref(source), /src="main.abc.js"/);
});

test('postbuild index rewrite is idempotent', () => {
  const html = '<base href="/en-US/">';
  assert.equal(fixEnglishBaseHref(html), html);
});

test('unrecognized base fails explicitly', () => {
  assert.throws(() => fixEnglishBaseHref('<base href="/zh/">'), /expected/);
});

test('Workers runtime config marks the English locale URL prefix', () => {
  const config = '(function(window) { window.__env = window.__env || {}; })(this);';
  const output = fixEnglishLocaleConfig(config);
  assert.match(output, /window\.__env\.ENGLISH_LOCALE_PREFIX = '\/en-US';/);
  assert.equal(fixEnglishLocaleConfig(output), output);
});

test('unexpected preexisting runtime locale prefix fails', () => {
  assert.throws(() => fixEnglishLocaleConfig('window.__env.ENGLISH_LOCALE_PREFIX = "/other";'), /Unexpected/);
});
