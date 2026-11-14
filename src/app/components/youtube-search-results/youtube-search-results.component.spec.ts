import { ComponentFixture, TestBed } from '@angular/core/testing';

import { YoutubeSearchResultsComponent } from './youtube-search-results.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('YoutubeSearchResultsComponent', () => {
  let fixture: ComponentFixture<YoutubeSearchResultsComponent>;
  const results = [
    { title: 'First clip', channelTitle: 'Channel one', thumbnailUrl: 'https://img.example.test/1.jpg', videoUrl: 'https://example.test/watch?v=1' },
    { title: 'Second clip', channelTitle: 'Channel two', thumbnailUrl: 'https://img.example.test/2.jpg', videoUrl: 'https://example.test/watch?v=2' }
  ] as any[];

  async function render(inputs: Record<string, unknown>) {
    configureTestBed({ imports: [YoutubeSearchResultsComponent] });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(YoutubeSearchResultsComponent);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  }

  const status = () => fixture.nativeElement.querySelector('[role="status"]').textContent.trim();

  it.each([
    ['searching is not set up', { active: false }, 'enable the'],
    ['a search is running', { active: true, loading: true }, 'Searching'],
    ['a search from this page failed', { active: true, failed: true, interactive: true }, 'Check your connection or API settings.'],
    ['a search on the server failed', { active: true, failed: true }, 'Check the server logs.'],
    ['nothing matched', { active: true }, 'No videos found.'],
    ['there are results', { active: true, results }, '2 videos found.']
  ])('says what the search is doing when %s', async (_case, inputs, text) => {
    await render(inputs);
    expect(status()).toContain(text);
  });

  it('lists each result and hands back its link when it is picked', async () => {
    await render({ active: true, results });
    const picked: string[] = [];
    fixture.componentInstance.selected.subscribe(url => picked.push(url));

    const items = fixture.nativeElement.querySelectorAll('.search-result');
    expect(items.length).toBe(2);
    expect(items[1].querySelector('.search-result-title').textContent).toBe('Second clip');
    expect(items[1].querySelector('.search-result-channel').textContent).toBe('Channel two');
    expect(items[1].querySelector('.search-result-view').getAttribute('href')).toBe('https://example.test/watch?v=2');

    items[1].querySelector('.search-result-select').click();
    expect(picked).toEqual(['https://example.test/watch?v=2']);
  });

  it('shows no list without results', async () => {
    await render({ active: true });
    expect(fixture.nativeElement.querySelector('.search-results')).toBeNull();
  });
});
