import { Location, LocationStrategy, PlatformLocation } from '@angular/common';
import { MockPlatformLocation } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { PlayerLocationStrategy } from './player-location-strategy';

describe('Player URLs', () => {
  let platform: MockPlatformLocation;
  let location: Location;

  function start(url: string, base = '/') {
    platform = new MockPlatformLocation({startUrl: `https://media.example${url}`, appBaseHref: base});
    TestBed.configureTestingModule({providers: [
      {provide: PlatformLocation, useValue: platform},
      {provide: LocationStrategy, useClass: PlayerLocationStrategy}
    ]});
    location = TestBed.inject(Location);
  }

  it('reads a direct player URL including its id on a fresh load', () => {
    start('/video?id=FileLink123');
    expect(location.path()).toBe('/video?id=FileLink123');
  });

  it('keeps old hash links readable', () => {
    start('/#/player;uid=file-1;queue_sort_by=title');
    expect(location.path()).toBe('/player;uid=file-1;queue_sort_by=title');
  });

  it('moves between ordinary player paths and hash pages without leaving a stale id', () => {
    start('/#/home');
    const queue = {playerQueue: {queue_sort_by: 'title'}};
    location.go('/video', 'id=FileLink123', queue);
    expect(platform.pathname + platform.search + platform.hash).toBe('/video?id=FileLink123');
    expect(location.getState()).toEqual(queue);
    location.go('/home');
    expect(platform.pathname + platform.search + platform.hash).toBe('/#/home');
    location.back();
    expect(location.path()).toBe('/video?id=FileLink123');
    expect(location.getState()).toEqual(queue);
  });

  it('keeps a proxy subdirectory for files, playlists, and legacy pages', () => {
    start('/media/video?id=FileLink123', '/media/');
    expect(location.path()).toBe('/video?id=FileLink123');
    location.go('/audio', 'id=AudioLink12');
    expect(platform.pathname).toBe('/media/audio');
    location.go('/playlist', 'id=ListLink123');
    expect(platform.pathname).toBe('/media/playlist');
    location.go('/subscriptions');
    expect(platform.pathname + platform.hash).toBe('/media/#/subscriptions');
  });
});
