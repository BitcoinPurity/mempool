import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The shared Angular sourceLocale must keep baseHref "/" for the Nginx site.
// Cloudflare Workers serves the English localized bundle under /en-US/,
// so patch ONLY that generated index.html before uploading static assets.
export function fixEnglishBaseHref(html) {
  if (/<base\s+href=["']\/en-US\/["']\s*\/?>/i.test(html)) {
    return html;
  }
  const sourceBase = /<base\s+href=["']\/["']\s*\/?>/i;
  if (!sourceBase.test(html)) {
    throw new Error('English index.html has no expected <base href="/"> tag');
  }
  return html.replace(sourceBase, '<base href="/en-US/">');
}

export function updateEnglishIndex(indexPath) {
  const html = readFileSync(indexPath, 'utf8');
  const updated = fixEnglishBaseHref(html);
  if (updated !== html) writeFileSync(indexPath, updated);
  return updated !== html;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = resolve('dist/mempool/browser/en-US/index.html');
  const changed = updateEnglishIndex(index);
  console.log(`[workers] ${changed ? 'Set' : 'Verified'} English base href /en-US/ in ${index}`);
}
