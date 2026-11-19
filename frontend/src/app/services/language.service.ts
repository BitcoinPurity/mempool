import { DOCUMENT, getLocaleId } from '@angular/common';
import { LOCALE_ID, Inject, Injectable } from '@angular/core';
import { languages } from '@app/app.constants';

@Injectable({
  providedIn: 'root'
})
export class LanguageService {
  private language = 'en';
  private languages = languages;

  constructor(
    @Inject(DOCUMENT) private document: Document,
    @Inject(LOCALE_ID) private locale: string,
  ) {
    this.language = getLocaleId(this.locale).substring(0, 2);
  }

  getLanguage(): string {
    return this.language;
  }

  /** Remove only the first recognized language segment (including source locale en-US). */
  stripLanguageFromUrl(urlPath?: string | null): string {
    const pathname = urlPath ?? this.document.location.pathname;
    const prefix = pathname.match(/^\/([^/]+)(?=\/|$)/)?.[1];
    if (prefix === 'en-US' || this.languages.some(lang => lang.code === prefix)) {
      return pathname.slice(prefix.length + 1) || '/';
    }
    return pathname;
  }

  /**
   * Traditional Nginx uses / for English. Cloudflare Workers builds inject
   * ENGLISH_LOCALE_PREFIX=/en-US into the published runtime config.
   */
  getLanguageForUrl(language: string = this.language): string {
    if (language !== 'en') {
      return '/' + language;
    }

    const view = this.document.defaultView as
      (Window & { __env?: { ENGLISH_LOCALE_PREFIX?: string } }) | null;
    return view?.__env?.ENGLISH_LOCALE_PREFIX === '/en-US' ? '/en-US' : '';
  }

  setLanguage(language: string): void {
    try {
      this.document.cookie = `lang=${language}; expires=Thu, 18 Dec 2050 12:00:00 UTC; path=/`;
    } catch (e) { }
  }
}
