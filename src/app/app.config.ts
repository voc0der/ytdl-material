import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { DatePipe, registerLocaleData } from '@angular/common';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideNativeDateAdapter } from '@angular/material/core';
import es from '@angular/common/locales/es';

import { routes } from './app.routes';
import { PostsService } from './posts.services';
import { h401InterceptorFn } from './http.interceptor';

registerLocaleData(es, 'es');

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection(),
    provideRouter(routes, withHashLocation()),
    provideHttpClient(withXhr(), withInterceptors([h401InterceptorFn])),
    provideNativeDateAdapter(),
    PostsService,
    DatePipe
  ]
};
