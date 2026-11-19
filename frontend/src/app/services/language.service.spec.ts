import { LanguageService } from './language.service';

describe('LanguageService language URL routing', () => {
  function createService(pathname: string, englishPrefix?: string, locale = 'en-US'): LanguageService {
    const fakeDocument = {
      location: { pathname },
      defaultView: { __env: { ENGLISH_LOCALE_PREFIX: englishPrefix } },
    } as unknown as Document;
    return new LanguageService(fakeDocument, locale);
  }

  it('removes the English en-US prefix from the Stage homepage', () => {
    expect(createService('/en-US/').stripLanguageFromUrl()).toBe('/');
  });

  it('preserves nested page routes when switching from en-US', () => {
    expect(createService('/en-US/signet/blocks').stripLanguageFromUrl()).toBe('/signet/blocks');
    expect(createService('/en-US/tx/abc').stripLanguageFromUrl()).toBe('/tx/abc');
  });

  it('recognizes regular language prefixes without removing unrelated paths', () => {
    const service = createService('/de/tx/abc');
    expect(service.stripLanguageFromUrl()).toBe('/tx/abc');
    expect(service.stripLanguageFromUrl('/zh/signet')).toBe('/signet');
    expect(service.stripLanguageFromUrl('/dashboard')).toBe('/dashboard');
    expect(service.stripLanguageFromUrl('/deutsch')).toBe('/deutsch');
  });

  it('uses the correct English URL when switching back from German on Workers', () => {
    const service = createService('/de/tx/abc', '/en-US', 'de');
    expect(service.getLanguageForUrl('en') + service.stripLanguageFromUrl()).toBe('/en-US/tx/abc');
    expect(service.getLanguageForUrl('zh') + service.stripLanguageFromUrl()).toBe('/zh/tx/abc');
  });

  it('retains traditional root-English URLs outside Workers', () => {
    const service = createService('/de/', undefined, 'de');
    expect(service.getLanguageForUrl('en') + service.stripLanguageFromUrl()).toBe('/');
  });
});
