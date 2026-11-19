import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, Inject, OnInit } from '@angular/core';
import { UntypedFormBuilder, UntypedFormGroup } from '@angular/forms';
import { languages } from '@app/app.constants';
import { LanguageService } from '@app/services/language.service';

@Component({
  selector: 'app-language-selector',
  templateUrl: './language-selector.component.html',
  styleUrls: ['./language-selector.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LanguageSelectorComponent implements OnInit {
  languageForm: UntypedFormGroup;
  languages = languages;

  constructor(
    @Inject(DOCUMENT) private document: Document,
    private formBuilder: UntypedFormBuilder,
    private languageService: LanguageService,
  ) { }

  ngOnInit() {
    this.languageForm = this.formBuilder.group({
      language: ['en']
    });
    this.languageForm.get('language').setValue(this.languageService.getLanguage());
  }

  changeLanguage() {
    const newLang = this.languageForm.get('language').value;
    this.languageService.setLanguage(newLang);
    const rawUrlPath = this.languageService.stripLanguageFromUrl();
    const prefix = this.languageService.getLanguageForUrl(newLang);
    // Preserve the current route, query string and anchor during locale switches.
    this.document.location.href = prefix + rawUrlPath +
      this.document.location.search + this.document.location.hash;
  }
}
