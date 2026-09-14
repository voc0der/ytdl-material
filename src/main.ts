import { enableProdMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { environment } from './environments/environment';

import { loadTranslations } from '@angular/localize';

if (environment.production) {
  enableProdMode();
}

// The app is imported only after translations load, so any $localize evaluated while its
// modules initialize already sees the selected locale.
function bootstrap() {
  Promise.all([import('./app/app.component'), import('./app/app.config')])
    .then(([{ AppComponent }, { appConfig }]) => bootstrapApplication(AppComponent, appConfig))
    .catch(err => console.error(err));
}

const locale = localStorage.getItem('locale');
if (!locale) {
  localStorage.setItem('locale', 'en');
}
if (locale && locale !== 'en') {
  fetch(`./assets/i18n/messages.${locale}.json`)
    .then(res => res.json())
    .then(data => loadTranslations(data as any))
    .catch(() => undefined)
    .then(() => bootstrap());
} else {
  bootstrap();
}
