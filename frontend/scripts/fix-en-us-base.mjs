import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep Angular sourceLocale base "/" for the regular Nginx deployment.
// Cloudflare Workers serves English from /en-US/ instead.
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

// Mark English's public URL prefix in *only* the Workers output.
// Other localized bundles load the same /resources/config.js, so switching
// from /de/ or /zh/ back to English also resolves to /en-US/ on Cloudflare.
const ENGLISH_PREFIX_SETTING = "window.__env.ENGLISH_LOCALE_PREFIX = '/en-US';";
export function fixEnglishLocaleConfig(configJs) {
  if (configJs.includes(ENGLISH_PREFIX_SETTING)) {
    return configJs;
  }
  if (/window\.__env\.ENGLISH_LOCALE_PREFIX\s*=/.test(configJs)) {
    throw new Error('Unexpected existing ENGLISH_LOCALE_PREFIX setting');
  }
  return configJs + '\nwindow.__env = window.__env || {};\n' + ENGLISH_PREFIX_SETTING + '\n';
}

function patchFile(filePath, transform) {
  const original = readFileSync(filePath, 'utf8');
  const updated = transform(original);
  if (updated !== original) writeFileSync(filePath, updated);
  return updated !== original;
}

export function updateEnglishIndex(indexPath) {
  return patchFile(indexPath, fixEnglishBaseHref);
}

export function updateEnglishConfig(configPath) {
  return patchFile(configPath, fixEnglishLocaleConfig);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = resolve('dist/mempool/browser');
  const index = resolve(base, 'en-US/index.html');
  const config = resolve(base, 'resources/config.js');
  console.log(`[workers] ${updateEnglishIndex(index) ? 'Set' : 'Verified'} English base href /en-US/`);
  console.log(`[workers] ${updateEnglishConfig(config) ? 'Set' : 'Verified'} English locale URL prefix /en-US/`);
}
