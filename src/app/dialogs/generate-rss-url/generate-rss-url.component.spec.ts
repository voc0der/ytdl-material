import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, UrlSerializer } from '@angular/router';

import { GenerateRssUrlComponent } from './generate-rss-url.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('GenerateRssUrlComponent', () => {
  let component: GenerateRssUrlComponent;
  let fixture: ComponentFixture<GenerateRssUrlComponent>;
  let queryParams = {};

  beforeEach(async () => {
    await configureTestBed({
      declarations: [ GenerateRssUrlComponent ],
      providers: [
        {
          provide: Router,
          useValue: {
            createUrlTree: (_commands, options) => {
              queryParams = options.queryParams;
              return {};
            }
          }
        },
        { provide: UrlSerializer, useValue: { serialize: () => '?feed' } }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(GenerateRssUrlComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('uses the feed token and never a caller-selected user uid', () => {
    component.apiToken = 'ytdl_feed_token';
    component.rebuildURL();

    expect(queryParams['apiToken']).toBe('ytdl_feed_token');
    expect(queryParams['uuid']).toBeUndefined();
  });
});
