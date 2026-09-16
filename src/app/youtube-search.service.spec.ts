import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { YoutubeSearchService } from './youtube-search.service';
import { configureTestBed } from '../testing/test-bed';

describe('YoutubeSearchService', () => {
  beforeEach(() => configureTestBed({ providers: [provideHttpClient(), provideHttpClientTesting()] }));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('should be created', () => {
    const service: YoutubeSearchService = TestBed.inject(YoutubeSearchService);
    expect(service).toBeTruthy();
  });

  it('encodes search text as one query parameter and maps videos for the results list', () => {
    const service = TestBed.inject(YoutubeSearchService);
    const http = TestBed.inject(HttpTestingController);
    const query = 'music & science #1 + café?maxResults=50';
    service.initializeAPI('test-key');
    const results = vi.fn();
    service.search(query).subscribe(results);

    const request = http.expectOne(req => req.url === service.url);
    const url = new URL(request.request.urlWithParams);
    expect(url.searchParams.get('q')).toBe(query);
    expect(url.searchParams.get('maxResults')).toBe('5');
    expect(url.searchParams.get('key')).toBe('test-key');
    request.flush({ items: [{
      id: { videoId: 'video-1' },
      snippet: { title: 'Moon landing', description: 'NASA footage', channelTitle: 'NASA',
        publishedAt: '2026-01-01T00:00:00Z', thumbnails: { high: { url: 'https://example.com/thumbnail.jpg' } } }
    }] });
    expect(results).toHaveBeenCalledWith([expect.objectContaining({
      title: 'Moon landing', channelTitle: 'NASA', videoUrl: 'https://www.youtube.com/watch?v=video-1'
    })]);
  });
});
