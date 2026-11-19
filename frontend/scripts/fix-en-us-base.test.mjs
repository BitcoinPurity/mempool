import test from 'node:test';
import assert from 'node:assert/strict';
import { fixEnglishBaseHref } from './fix-en-us-base.mjs';

test('English localized index uses /en-US/ for Angular route and scripts', () => {
  const source = '<html><head><base href="/"><script src="main.abc.js"></script></head></html>';
  assert.match(fixEnglishBaseHref(source), /<base href="\/en-US\/">/);
  assert.match(fixEnglishBaseHref(source), /src="main.abc.js"/);
});

test('postbuild rewrite is idempotent', () => {
  const html = '<base href="/en-US/">';
  assert.equal(fixEnglishBaseHref(html), html);
});

test('unrecognized base fails explicitly instead of silently deploying a blank English page', () => {
  assert.throws(() => fixEnglishBaseHref('<base href="/zh/">'), /expected/);
});
