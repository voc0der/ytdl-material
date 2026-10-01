import { inject } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, DefaultUrlSerializer, provideRouter, Router, UrlSerializer } from '@angular/router';

import { AppComponent } from './app.component';
import { PostsService } from './posts.services';
import { SubscriptionActionsService } from './subscriptions/subscription-actions.service';
import { configureTestBed } from '../testing/test-bed';

const ARTWORK_URL = 'http://localhost/api/subscriptionArtwork/with-art';

/*************************************************
 * The subscriptions in the side menu, rendered
 * through ngx-avatars: the artwork when there is
 * some, and the name's initials when there is none
 * or it fails to load. A real router, because the
 * menu's links mark the current page.
 ************************************************/
describe('AppComponent menu subscriptions', () => {
  let fixture: ComponentFixture<AppComponent>;
  let postsService: any;

  const entries = () => Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('a.navigation-link'))
    .filter(link => link.querySelector('ngx-avatars'));
  const avatar = (name: string) => entries().find(link => link.textContent.includes(name)).querySelector('ngx-avatars');
  const initials = (name: string) => avatar(name).querySelector('div.avatar-content')?.textContent.trim();

  beforeEach(async () => {
    await configureTestBed({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        {provide: Router, useClass: Router},
        {provide: UrlSerializer, useClass: DefaultUrlSerializer},
        {provide: ActivatedRoute, useFactory: () => inject(Router).routerState.root},
        {provide: SubscriptionActionsService, useValue: {artworkURL: (sub: {id: string}) => sub.id === 'with-art' ? ARTWORK_URL : null}}
      ]
    }).compileComponents();

    postsService = TestBed.inject(PostsService);
    postsService.hasPermission = () => true;
    postsService.subscriptions = [{id: 'with-art', name: 'Channel Name'}, {id: 'no-art', name: 'plain'}];
    fixture = TestBed.createComponent(AppComponent);
    fixture.componentInstance.allowSubscriptions = true;
    fixture.detectChanges();
  });

  it('shows a subscription\'s artwork at the menu\'s icon size', () => {
    const image: HTMLImageElement = avatar('Channel Name').querySelector('img');
    expect(image.getAttribute('src')).toBe(ARTWORK_URL);
    expect(image.width).toBe(28);
    expect(image.height).toBe(28);
    expect((avatar('Channel Name').querySelector('.avatar-container') as HTMLElement).style.width).toBe('28px');
  });

  it('falls back to two initials when the artwork does not load', () => {
    avatar('Channel Name').querySelector('img').dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(avatar('Channel Name').querySelector('img')).toBeNull();
    expect(initials('Channel Name')).toBe('CN');
  });

  it('uses the initials straight away when there is no artwork', () => {
    expect(avatar('plain').querySelector('img')).toBeNull();
    expect(initials('plain')).toBe('P');
  });

  it('links each subscription to its page', () => {
    expect(entries().map(link => link.getAttribute('href'))).toEqual(['/subscription;id=with-art', '/subscription;id=no-art']);
  });

  it('lists none while you are browsing someone else\'s library', () => {
    postsService.viewed_library = {uid: 'alice', name: 'Alice'};
    fixture.detectChanges();
    expect(entries()).toEqual([]);
  });
});
