import { Component, inject, OnDestroy } from '@angular/core';
import { Location, PlatformLocation } from '@angular/common';
import { MockPlatformLocation } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, NavigationEnd, provideRouter, Router, RouteReuseStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { filter, firstValueFrom, take } from 'rxjs';
import { routes } from './app.routes';
import { MainComponent } from './main/main.component';
import { PlayerComponent } from './player/player.component';
import { PlayerRouteReuseStrategy } from './player/player-route-reuse-strategy';

@Component({template: 'Home'})
class HomePage {}

@Component({template: 'Page'})
class OtherPage {}

@Component({template: 'Playing {{id}}'})
class PlayerPage implements OnDestroy {
  readonly id = inject(ActivatedRoute).snapshot.queryParamMap.get('v');
  destroyed = false;
  ngOnDestroy() { this.destroyed = true; }
}

describe('App paths', () => {
  let platform: MockPlatformLocation;
  beforeEach(() => {
    platform = new MockPlatformLocation({startUrl: 'https://media.example/', appBaseHref: '/'});
    TestBed.configureTestingModule({providers: [
      {provide: PlatformLocation, useValue: platform},
      {provide: RouteReuseStrategy, useClass: PlayerRouteReuseStrategy},
      provideRouter(routes.map(route => ({...route, canActivate: [],
        component: route.component === MainComponent ? HomePage : route.component === PlayerComponent ? PlayerPage : OtherPage
      })))
    ]});
  });

  it('selects home or playback at the root without a hash', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/', HomePage);
    expect(platform.pathname + platform.search + platform.hash).toBe('/');
    const player = await harness.navigateByUrl('/?v=FileLink123', PlayerPage);
    expect(player.id).toBe('FileLink123');
    expect(platform.pathname + platform.search + platform.hash).toBe('/?v=FileLink123');
    await harness.navigateByUrl('/', HomePage);
    expect(player.destroyed).toBe(true);
  });

  it.each(['/downloads', '/subscriptions', '/settings'])('uses an ordinary path for %s', async path => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(path, OtherPage);
    expect(platform.pathname + platform.search + platform.hash).toBe(path);
  });

  it('recreates playback when the id changes, and restores the previous entry with Back', async () => {
    const harness = await RouterTestingHarness.create();
    const router = TestBed.inject(Router);
    router.setUpLocationChangeListener();
    const location = TestBed.inject(Location);
    await router.navigate(['/'], {queryParams: {v: 'FirstLink12'}, state: {playerQueue: {queue_sort_by: 'title'}}});
    const first = harness.routeDebugElement.componentInstance as PlayerPage;
    const second = await harness.navigateByUrl('/?v=SecondLink1', PlayerPage);
    expect(first.destroyed).toBe(true);
    expect(second.id).toBe('SecondLink1');
    const back = firstValueFrom(router.events.pipe(filter(event => event instanceof NavigationEnd), take(1)));
    location.back();
    await back;
    expect(second.destroyed).toBe(true);
    expect((harness.routeDebugElement.componentInstance as PlayerPage).id).toBe('FirstLink12');
    expect((location.getState() as any).playerQueue).toEqual({queue_sort_by: 'title'});
  });

  it.each(['/home', '/player;uid=file-1', '/video?id=FileLink123', '/audio?id=AudioLink12', '/playlist?id=ListLink123'])('does not register the removed route %s', async url => {
    const harness = await RouterTestingHarness.create();
    await expect(harness.navigateByUrl(url)).rejects.toThrow(/Cannot match any routes/);
  });

  it('does not interpret an old hash link as a player route', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/#/player;uid=file-1', HomePage);
    expect(harness.routeNativeElement.textContent).toBe('Home');
  });
});
