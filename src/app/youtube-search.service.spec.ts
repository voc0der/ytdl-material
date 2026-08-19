import { TestBed } from '@angular/core/testing';

import { YoutubeSearchService } from './youtube-search.service';
import { configureTestBed } from '../testing/test-bed';

describe('YoutubeSearchService', () => {
  beforeEach(() => configureTestBed({}));

  it('should be created', () => {
    const service: YoutubeSearchService = TestBed.inject(YoutubeSearchService);
    expect(service).toBeTruthy();
  });
});
