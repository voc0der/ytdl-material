// Shared TestBed configuration for component specs.
//
// The unit-test builder compiles each spec as its own bundle, so a setup file that patched
// TestBed.configureTestingModule globally (as the karma setup did) could not reach them, and
// a class token registered from a separate bundle is not the same object the spec injects.
// Specs therefore call configureTestBed() and get the shared stubs, module imports and
// schemas merged into their own module definition.

import { DatePipe } from '@angular/common';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Router, UrlSerializer } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatMenuModule } from '@angular/material/menu';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PostsService } from '../app/posts.services';

function createUniversalStub(): any {
  const stubFn = function universalStub() {
    return proxy;
  };

  const proxy = new Proxy(stubFn as any, {
    apply: () => proxy,
    construct: () => proxy,
    get: (_target, prop: string | symbol) => {
      if (Reflect.has(stubFn, prop)) {
        return Reflect.get(stubFn, prop);
      }

      if (prop === 'subscribe') {
        return () => ({ unsubscribe() {} });
      }

      if (prop === 'pipe') {
        return () => proxy;
      }

      if (prop === 'toPromise') {
        return async () => proxy;
      }

      if (prop === 'then') {
        return undefined;
      }

      if (prop === Symbol.toPrimitive) {
        return (hint: string) => hint === 'number' ? 0 : '';
      }

      if (prop === 'toString') {
        return () => '';
      }

      if (prop === 'valueOf') {
        return () => '';
      }

      if (prop === Symbol.isConcatSpreadable) {
        return false;
      }

      if (prop === 'length') {
        return 0;
      }

      if (prop === Symbol.iterator) {
        return function* emptyIterator() {};
      }

      return proxy;
    },
    set: (target, prop, value) => Reflect.set(target, prop, value)
  });

  return proxy;
}

function createPostsServiceStub(): any {
  const stub = createUniversalStub();

  Object.assign(stub, {
    initialized: false,
    isLoggedIn: false,
    user: null,
    card_size: 'medium',
    sidepanel_mode: 'over',
    theme: { key: 'default' },
    categories: [],
    permissions: [],
    available_permissions: [],
    service_initialized: createUniversalStub(),
    config_reloaded: createUniversalStub(),
    open_create_default_admin_dialog: createUniversalStub(),
    reload_config: createUniversalStub(),
    files_changed: createUniversalStub(),
    config: {
      Downloader: {
        use_youtubedl_archive: false
      },
      Host: {
        url: 'http://localhost',
        port: 17442
      },
      Extra: {
        title_top: 'ytdl-material',
        enable_downloads_manager: false
      },
      Themes: {
        default_theme: 'default',
        allow_theme_change: true
      },
      Subscriptions: {
        allow_subscriptions: false
      },
      Advanced: {
        multi_user_mode: false
      },
      API: {
        API_key: 'test-key'
      }
    }
  });

  return stub;
}

function createRouterStub() {
  const router = createUniversalStub();
  Object.assign(router, {
    url: '/',
    navigate: () => Promise.resolve(true),
    navigateByUrl: () => Promise.resolve(true),
    events: createUniversalStub()
  });
  return router;
}

function createDialogDataStub() {
  return {
    file: {
      uid: 'file-1',
      title: 'Test file',
      upload_date: '2024-01-01',
      category: null,
      user_uid: null,
      favorite: false
    },
    category: {
      uid: 'cat-1',
      name: 'Test category',
      rules: []
    },
    sub: {
      id: 'sub-1',
      name: 'Test subscription',
      type: 'video',
      timerange: null,
      videos: [],
      custom_args: ''
    },
    user: {
      uid: 'user-1',
      permissions: [],
      permission_overrides: []
    },
    subscription: {
      name: 'Test subscription',
      videos: [],
      downloading: false
    },
    initial_args: '',
    task: {
      key: 'task-1',
      schedule: {
        data: {
          timestamp: Date.now()
        }
      }
    },
    schedule: {
      minute: '*',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*'
    }
  };
}

function createActivatedRouteStub() {
  return {
    snapshot: {
      params: {},
      queryParams: {},
      paramMap: convertToParamMap({}),
      queryParamMap: convertToParamMap({})
    },
    params: createUniversalStub(),
    queryParams: createUniversalStub(),
    paramMap: createUniversalStub(),
    queryParamMap: createUniversalStub(),
    data: createUniversalStub(),
    url: createUniversalStub()
  };
}

/**
 * TestBed.configureTestingModule with the stubs and module imports every component spec
 * depends on. errorOnUnknownElements/Properties are disabled to match NO_ERRORS_SCHEMA:
 * most specs declare a single component without its Material dependencies.
 */
export function configureTestBed(moduleDef: any = {}) {
  return TestBed.configureTestingModule({
    ...moduleDef,
    imports: [
      NoopAnimationsModule,
      MatAutocompleteModule,
      MatMenuModule,
      ...(moduleDef.imports || [])
    ],
    providers: [
      { provide: PostsService, useValue: createPostsServiceStub() },
      { provide: MatDialogRef, useValue: createUniversalStub() },
      { provide: MAT_DIALOG_DATA, useValue: createDialogDataStub() },
      { provide: ActivatedRoute, useValue: createActivatedRouteStub() },
      { provide: Router, useValue: createRouterStub() },
      { provide: UrlSerializer, useValue: { serialize: () => '' } },
      DatePipe,
      ...(moduleDef.providers || [])
    ],
    schemas: [NO_ERRORS_SCHEMA, ...(moduleDef.schemas || [])],
    errorOnUnknownElements: false,
    errorOnUnknownProperties: false
  });
}
