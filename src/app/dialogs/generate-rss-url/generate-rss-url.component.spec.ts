import { Clipboard } from '@angular/cdk/clipboard';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, DefaultUrlSerializer, provideRouter, Router, UrlSerializer } from '@angular/router';
import { Subject } from 'rxjs';

import { PostsService } from 'app/posts.services';
import { GenerateRssUrlComponent } from './generate-rss-url.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('GenerateRssUrlComponent', () => {
  let component: GenerateRssUrlComponent;
  let fixture: ComponentFixture<GenerateRssUrlComponent>;
  let tokenResponse: Subject<any>;
  let postsService: any;
  let clipboard: { copy: ReturnType<typeof vi.fn> };

  const feedURL = () => new URL(component.url);
  const tokenButton = () => Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
    .find(button => button.textContent.includes('Generate feed token'))!;
  // These fields have an extra encoding layer, decoded by the feed endpoint.
  const decodedParam = (name: string) => decodeURIComponent(feedURL().searchParams.get(name)!);

  beforeEach(async () => {
    tokenResponse = new Subject();
    clipboard = { copy: vi.fn().mockReturnValue(true) };
    postsService = {
      config: {
        Host: { url: 'https://media.example.com', port: 17442 },
        Advanced: { multi_user_mode: true }
      },
      subscriptions: [{ id: 'subscription & one', name: 'First subscription' }],
      generateAPIToken: vi.fn().mockReturnValue(tokenResponse),
      openSnackBar: vi.fn()
    };
    await configureTestBed({
      imports: [ GenerateRssUrlComponent ],
      providers: [
        provideRouter([]),
        { provide: Router, useClass: Router },
        { provide: ActivatedRoute, useFactory: (router: Router) => router.routerState.root, deps: [Router] },
        { provide: UrlSerializer, useClass: DefaultUrlSerializer },
        { provide: PostsService, useValue: postsService },
        { provide: Clipboard, useValue: clipboard }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(GenerateRssUrlComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('generates the canonical feed endpoint with the real router and serializer', () => {
    expect(component.url).toBe('https://media.example.com:17442/api/rss');
    expect(feedURL().search).toBe('');
  });

  it('preserves text, subscription, sort, type, favorite and limit filters', () => {
    component.titleFilter = '100% café & music + #1';
    component.itemLimit = 5;
    component.favoriteFilter = true;
    component.fileTypeChanged('audio_only');
    component.subscriptionChanged('subscription & one');
    component.sortOptionChanged({ by: 'title', order: 1 });

    expect(feedURL().pathname).toBe('/api/rss');
    expect(decodedParam('text_search')).toBe('100% café & music + #1');
    expect(decodedParam('sub_id')).toBe('subscription & one');
    expect(JSON.parse(decodedParam('sort'))).toEqual({ by: 'title', order: 1 });
    expect(feedURL().searchParams.getAll('range')).toEqual(['0', '5']);
    expect(feedURL().searchParams.get('favorite_filter')).toBe('true');
    expect(feedURL().searchParams.get('file_type_filter')).toBe('audio_only');
    expect(feedURL().hash).toBe('');
  });

  it('removes cleared filters and the default sort from the URL', () => {
    component.titleFilter = 'clip';
    component.itemLimit = 3;
    component.favoriteFilter = true;
    component.subscriptionChanged('subscription & one');
    component.fileTypeChanged('video_only');
    component.sortOptionChanged({ by: 'title', order: -1 });
    expect(JSON.parse(decodedParam('sort'))).toEqual({ by: 'title', order: -1 });

    component.titleFilter = '';
    component.itemLimit = null;
    component.favoriteFilter = false;
    component.subscriptionChanged('');
    component.fileTypeChanged('both');
    component.sortOptionChanged({ by: 'registered', order: -1 });

    expect(feedURL().search).toBe('');
  });

  it('offers subscriptions and tolerates a list that has not loaded yet', () => {
    expect(component.subscriptionOptions).toEqual([
      { value: '', label: 'None' },
      { value: 'subscription & one', label: 'First subscription' }
    ]);
    postsService.subscriptions = null;
    expect(component.subscriptionOptions).toEqual([{ value: '', label: 'None' }]);
  });

  it('keeps copying a private feed disabled until its token is generated', () => {
    const generateButton = tokenButton();
    const copyButton: HTMLButtonElement = fixture.nativeElement.querySelector('[aria-label="Copy URL"]');
    expect(copyButton.disabled).toBe(true);
    component.copyURL();
    component.copyFeedToken();
    expect(clipboard.copy).not.toHaveBeenCalled();

    generateButton.click();
    fixture.detectChanges();
    expect(postsService.generateAPIToken).toHaveBeenCalledWith('RSS feed', 'rss');
    expect(component.tokenLoading).toBe(true);
    expect(generateButton.disabled).toBe(true);

    tokenResponse.next({ success: true, token: 'ytdl_feed_token' });
    fixture.detectChanges();
    expect(component.tokenLoading).toBe(false);
    expect(copyButton.disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('[aria-label="RSS token"]').value).toBe('ytdl_feed_token');
    component.rebuildURL();
    expect(component.url).not.toContain('ytdl_feed_token');
    expect(feedURL().searchParams.has('apiToken')).toBe(false);
    expect(feedURL().searchParams.has('uuid')).toBe(false);

    copyButton.click();
    expect(clipboard.copy).toHaveBeenLastCalledWith(component.url);
    fixture.nativeElement.querySelector('[aria-label="Copy token"]').click();
    expect(clipboard.copy).toHaveBeenLastCalledWith('ytdl_feed_token');
  });

  it.each([
    [{ success: false, error: 'Token limit reached' }, 'Token limit reached'],
    [{ success: true }, 'Could not generate an RSS token.'],
    [null, 'Could not generate an RSS token.']
  ])('shows a failed token response and allows another attempt: %j', (response, message) => {
    component.generateFeedToken();
    tokenResponse.next(response);
    fixture.detectChanges();

    expect(component.tokenLoading).toBe(false);
    expect(component.apiToken).toBeNull();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(message);

    component.generateFeedToken();
    expect(component.tokenLoading).toBe(true);
    expect(component.tokenError).toBeNull();
  });

  it('recovers from a failed token request', () => {
    component.generateFeedToken();
    tokenResponse.error({ error: { error: 'Request failed' } });
    fixture.detectChanges();

    expect(component.tokenLoading).toBe(false);
    expect(component.tokenError).toBe('Request failed');
    expect(component.apiToken).toBeNull();
    expect(tokenButton().disabled).toBe(false);
  });

  it('allows copying a public feed without a token', () => {
    fixture.destroy();
    postsService.config.Advanced.multi_user_mode = false;
    fixture = TestBed.createComponent(GenerateRssUrlComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    const copyButton: HTMLButtonElement = fixture.nativeElement.querySelector('[aria-label="Copy URL"]');
    expect(copyButton.disabled).toBe(false);
    copyButton.click();
    expect(clipboard.copy).toHaveBeenCalledWith(component.url);
    expect(postsService.generateAPIToken).not.toHaveBeenCalled();
  });
});
