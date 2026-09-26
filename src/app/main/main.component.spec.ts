import { MainComponent } from './main.component';
import { Observable, of, Subject, throwError } from 'rxjs';
import { Result } from '../youtube-search.service';

describe('MainComponent', () => {
  let component: MainComponent;

  beforeEach(() => {
    const posts_service_mock: any = {
      config: {
        Extra: {
          file_manager_enabled: false,
          download_only_mode: false,
          force_autoplay: false,
          allow_quality_select: false
        },
        Downloader: {
          custom_args: ''
        },
        API: {},
        Advanced: {
          allow_advanced_download: false,
          use_default_downloading_agent: true,
          custom_downloading_agent: ''
        }
      },
      hasPermission: () => true,
      getCurrentDownload: () => of({ download: null }),
      downloadFile: () => of({ download: { uid: 'queued-default' } }),
      generateArgs: () => of({ args: [] }),
      getFileFormats: () => of({ result: null }),
      openSnackBar: () => { },
      files_changed: {
        next: vi.fn().mockName('filesChangedNext')
      },
      playlists_changed: {
        next: vi.fn().mockName('playlistsChangedNext')
      },
      config_reloaded: of(false),
      service_initialized: of(true),
      initialized: true
    };
    const youtube_search_mock: any = { initializeAPI: () => { } };
    const snack_bar_mock: any = { open: () => { } };
    const router_mock: any = { navigate: () => { }, url: '/home' };
    const dialog_mock: any = { open: () => ({ afterClosed: () => of(null) }) };
    const platform_mock: any = { IOS: false };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };

    component = new MainComponent(posts_service_mock, youtube_search_mock, snack_bar_mock, router_mock, dialog_mock, platform_mock, route_mock);
  });

  it('should create component instance', () => {
    expect(component).toBeTruthy();
  });

  describe('URL and YouTube search modes', () => {
    let search: ReturnType<typeof vi.fn>;
    let serverSearch: ReturnType<typeof vi.fn>;
    const result = new Result({ id: 'video-1', title: 'Moon landing', channelTitle: 'NASA' });
    const enter = () => ({ preventDefault: vi.fn() }) as unknown as Event;

    beforeEach(() => {
      vi.useFakeTimers();
      search = vi.fn().mockReturnValue(of([result]));
      serverSearch = vi.fn().mockReturnValue(of({ results: [{ ...result }] }));
      (component as any).youtubeSearch.search = search;
      (component as any).postsService.searchVideos = serverSearch;
      component.youtubeSearchEnabled = true;
      component.urlInput = { nativeElement: { focus: vi.fn() } } as any;
      component.attachToInput();
    });

    afterEach(() => {
      component.ngOnDestroy();
      vi.useRealTimers();
    });

    it('defaults to URL mode and never searches URL input or plain text', () => {
      expect(component.inputMode).toBe('url');
      component.inputChanged('moon landing');
      component.inputChanged('https://www.youtube.com/watch?v=video-1');
      vi.advanceTimersByTime(1000);

      expect(search).not.toHaveBeenCalled();
      expect(component.results_showing).toBe(false);
    });

    it('debounces input changes (including paste) without probing formats or repeating the same query', () => {
      const probe = vi.spyOn(component, 'getURLInfo');
      component.allowQualitySelect = true;
      component.toggleInputMode();
      component.inputChanged('moon');
      vi.advanceTimersByTime(200);
      component.inputChanged('moon landing');
      vi.advanceTimersByTime(249);
      expect(search).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(search).toHaveBeenCalledExactlyOnceWith('moon landing');
      expect(component.results).toEqual([result]);
      component.inputChanged('moon landing ');
      component.submitSearch(enter());
      vi.advanceTimersByTime(1000);
      expect(search).toHaveBeenCalledTimes(1);
      expect(serverSearch).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(component.url).toBe('');
    });

    it('cancels an in-flight request as soon as the query changes', () => {
      const pending = new Subject<Result[]>();
      const cancelled = vi.fn();
      search.mockReturnValueOnce(new Observable<Result[]>(subscriber => {
        const subscription = pending.subscribe(subscriber);
        return () => { cancelled(); subscription.unsubscribe(); };
      }));
      component.toggleInputMode();
      component.inputChanged('moon');
      vi.advanceTimersByTime(250);
      component.inputChanged('mars');

      expect(cancelled).toHaveBeenCalledTimes(1);
      pending.next([result]);
      expect(component.results).toEqual([]);
      vi.advanceTimersByTime(250);
      expect(search).toHaveBeenLastCalledWith('mars');
    });

    it('keeps separate drafts and URL options, and cancels a pending search when switching modes', () => {
      const url = 'https://www.youtube.com/watch?v=original';
      component.inputChanged(url);
      component.selectedQuality = '720';
      component.toggleInputMode();
      component.inputChanged('moon landing');
      component.downloadClicked();
      expect(component.downloadingfile).toBe(false);
      component.toggleInputMode();
      vi.advanceTimersByTime(1000);

      expect(search).not.toHaveBeenCalled();
      expect(component.url).toBe(url);
      expect(component.selectedQuality).toBe('720');
      expect(component.results_loading).toBe(false);
      component.toggleInputMode();
      expect(component.searchQuery).toBe('moon landing');
      vi.advanceTimersByTime(250);
      expect(search).toHaveBeenCalledExactlyOnceWith('moon landing');
    });

    it('clears stale results on short queries, empty input, and Escape', () => {
      component.toggleInputMode();
      component.inputChanged('moon');
      vi.advanceTimersByTime(250);
      component.inputChanged('m');
      expect(component.results).toEqual([]);
      expect(component.results_showing).toBe(false);
      component.inputChanged('mars');
      component.clearInput();
      vi.advanceTimersByTime(250);
      expect(component.searchQuery).toBe('');
      component.inputChanged('venus');
      component.dismissSearch();
      vi.advanceTimersByTime(250);
      expect(component.results_showing).toBe(false);
      expect(search).toHaveBeenCalledTimes(1);
    });

    it('recovers after an API failure and distinguishes empty results', () => {
      search.mockReturnValueOnce(throwError(() => new Error('unavailable'))).mockReturnValueOnce(of([]));
      component.toggleInputMode();
      component.inputChanged('moon');
      vi.advanceTimersByTime(250);
      expect(component.searchFailed).toBe(true);
      expect(component.results_loading).toBe(false);
      component.inputChanged('mars');
      vi.advanceTimersByTime(250);
      expect(component.searchFailed).toBe(false);
      expect(component.results_showing).toBe(true);
      expect(component.results).toEqual([]);
    });

    it('selects a result into URL mode and probes only the selected URL', () => {
      const probe = vi.spyOn(component, 'getURLInfo').mockReturnValue(undefined);
      component.allowQualitySelect = true;
      component.toggleInputMode();
      component.inputChanged('moon landing');
      vi.advanceTimersByTime(250);
      component.useURL(result.videoUrl);

      expect(component.inputMode).toBe('url');
      expect(component.url).toBe(result.videoUrl);
      expect(component.results_showing).toBe(false);
      expect(probe).toHaveBeenCalledExactlyOnceWith(result.videoUrl);
    });

    it('does not request search after destruction', () => {
      component.toggleInputMode();
      component.inputChanged('mars');
      component.ngOnDestroy();
      vi.advanceTimersByTime(250);
      expect(search).not.toHaveBeenCalled();
    });

    it('without an API key, waits for Enter and searches through the server', () => {
      component.youtubeSearchEnabled = false;
      component.toggleInputMode();
      component.inputChanged('moon landing');
      vi.advanceTimersByTime(1000);
      expect(serverSearch).not.toHaveBeenCalled();
      expect(component.results_showing).toBe(false);

      const event = enter();
      component.submitSearch(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(serverSearch).toHaveBeenCalledExactlyOnceWith('moon landing');
      expect(search).not.toHaveBeenCalled();
      expect(component.results_loading).toBe(false);
      expect(component.results).toEqual([result]);
      expect(component.results[0]).toBeInstanceOf(Result);
    });

    it('without an API key, keeps submitted results while editing and never searches on a mode switch', () => {
      component.youtubeSearchEnabled = false;
      component.toggleInputMode();
      component.inputChanged('moon');
      component.submitSearch(enter());
      component.inputChanged('moon landing');
      vi.advanceTimersByTime(1000);
      expect(component.results).toEqual([result]);

      component.toggleInputMode();
      component.toggleInputMode();
      vi.advanceTimersByTime(1000);
      expect(component.results_showing).toBe(false);
      expect(serverSearch).toHaveBeenCalledTimes(1);

      component.submitSearch(enter());
      component.inputChanged('');
      expect(component.results_showing).toBe(false);
      expect(component.results).toEqual([]);
    });

    it('without an API key, retries the same query on Enter after a failure', () => {
      serverSearch.mockReturnValueOnce(throwError(() => new Error('unavailable'))).mockReturnValueOnce(of({ results: [] }));
      component.youtubeSearchEnabled = false;
      component.toggleInputMode();
      component.inputChanged('moon');
      component.submitSearch(enter());
      expect(component.searchFailed).toBe(true);
      expect(component.results_loading).toBe(false);

      component.submitSearch(enter());
      expect(serverSearch).toHaveBeenCalledTimes(2);
      expect(component.searchFailed).toBe(false);
      expect(component.results_showing).toBe(true);
      expect(component.results).toEqual([]);
    });

    it('starts a waiting search when the API configuration arrives after the view', async () => {
      component.youtubeSearchEnabled = false;
      component.toggleInputMode();
      component.inputChanged('moon');
      (component as any).postsService.config.API = { use_youtube_API: true, youtube_API_key: 'test-key' };

      await component.loadConfig();
      vi.advanceTimersByTime(250);

      expect(component.youtubeSearchEnabled).toBe(true);
      expect(search).toHaveBeenCalledExactlyOnceWith('moon');
    });
  });

  it('keeps polling state for unfinished downloads even when percent is null', () => {
    const api_download = {
      uid: 'download-1',
      percent_complete: null,
      finished: false,
      error: null
    };
    (component as any).postsService.getCurrentDownload = () => of({ download: api_download });
    component.current_download = { uid: 'download-1' } as any;
    component.downloadingfile = true;

    component.getCurrentDownload();

    expect(component.current_download).toEqual(api_download as any);
    expect(component.downloadingfile).toBe(true);
  });

  it('reloads videos when a finished download has no container metadata', () => {
    const api_download = {
      uid: 'download-2',
      percent_complete: 100,
      finished: true,
      error: null,
      file_uids: null,
      type: 'video',
      container: null
    };
    const reload_spy = vi.spyOn(component, 'reloadMediaLibrary').mockReturnValue(undefined);
    const helper_spy = vi.spyOn(component, 'downloadHelper').mockReturnValue(undefined);
    (component as any).postsService.getCurrentDownload = () => of({ download: api_download });
    component.current_download = { uid: 'download-2' } as any;
    component.downloadingfile = true;

    component.getCurrentDownload();

    expect(helper_spy).not.toHaveBeenCalled();
    expect(reload_spy).toHaveBeenCalledWith(false);
    expect(component.downloadingfile).toBe(false);
    expect(component.current_download).toBeNull();
  });

  it('routes finished downloads through downloadHelper when metadata is present', () => {
    const api_download = {
      uid: 'download-3',
      percent_complete: 100,
      finished: true,
      error: null,
      file_uids: ['file-1'],
      type: 'video',
      container: { uid: 'file-1' }
    };
    const helper_spy = vi.spyOn(component, 'downloadHelper').mockReturnValue(undefined);
    (component as any).postsService.getCurrentDownload = () => of({ download: api_download });
    component.current_download = { uid: 'download-3' } as any;

    component.getCurrentDownload();

    expect(helper_spy).toHaveBeenCalledWith(api_download.container as any, 'video', false, false);
    expect(component.current_download).toBeNull();
  });

  it('reloads the media library before navigating to the player on autoplay', () => {
    component.autoplay = true;
    const reload_spy = vi.spyOn(component, 'reloadMediaLibrary');
    const router_navigate_spy = vi.spyOn((component as any).router, 'navigate').mockReturnValue(undefined);

    component.downloadHelper({ uid: 'file-1' } as any, 'video', false, false);

    expect(reload_spy).toHaveBeenCalledWith(false);
    expect((component as any).postsService.files_changed.next).toHaveBeenCalledWith(true);
    expect(router_navigate_spy).toHaveBeenCalledWith(['/player', { type: 'video', uid: 'file-1' }]);
  });

  it('shows a dialog instead of reopening a skipped duplicate single download', () => {
    const api_download = {
      uid: 'download-3b',
      percent_complete: 100,
      finished: true,
      error: null,
      duplicate_skip_only: true,
      file_uids: ['file-1'],
      type: 'video',
      title: 'Existing video',
      container: { uid: 'file-1' }
    };
    const helper_spy = vi.spyOn(component, 'downloadHelper').mockReturnValue(undefined);
    const reload_spy = vi.spyOn(component, 'reloadMediaLibrary').mockReturnValue(undefined);
    const dialog_spy = vi.spyOn((component as any).dialog, 'open').mockReturnValue({ afterClosed: () => of(null) } as any);
    (component as any).postsService.getCurrentDownload = () => of({ download: api_download });
    component.current_download = { uid: 'download-3b' } as any;

    component.getCurrentDownload();

    expect(helper_spy).not.toHaveBeenCalled();
    expect(reload_spy).toHaveBeenCalledWith(false);
    expect(dialog_spy).toHaveBeenCalled();
    expect(component.current_download).toBeNull();
  });

  it('advances to the next queued download after a finished item without container metadata', () => {
    const api_download = {
      uid: 'download-4',
      percent_complete: 100,
      finished: true,
      error: null,
      file_uids: ['file-1', 'file-2'],
      type: 'video',
      container: null
    };
    const reload_spy = vi.spyOn(component, 'reloadMediaLibrary').mockReturnValue(undefined);
    (component as any).postsService.getCurrentDownload = () => of({ download: api_download });
    component.current_download = { uid: 'download-4' } as any;
    component.downloads = [{ uid: 'download-4' } as any, { uid: 'download-5' } as any];
    component.download_uids = ['download-4', 'download-5'];

    component.getCurrentDownload();

    expect(component.download_uids).toEqual(['download-5']);
    expect(component.current_download && component.current_download.uid).toBe('download-5');
    expect(reload_spy).not.toHaveBeenCalled();
  });

  it('removes finished errored downloads and continues polling remaining queue', () => {
    const api_download = {
      uid: 'download-6',
      percent_complete: 100,
      finished: true,
      error: 'failed',
      file_uids: null,
      type: 'video',
      container: null
    };
    (component as any).postsService.getCurrentDownload = () => of({ download: api_download });
    component.current_download = { uid: 'download-6' } as any;
    component.downloads = [{ uid: 'download-6' } as any, { uid: 'download-7' } as any];
    component.download_uids = ['download-6', 'download-7'];

    component.getCurrentDownload();

    expect(component.download_uids).toEqual(['download-7']);
    expect(component.current_download && component.current_download.uid).toBe('download-7');
  });

  it('removes downloads by uid even when object references differ', () => {
    component.current_download = { uid: 'download-8' } as any;
    component.downloads = [{ uid: 'download-8' } as any, { uid: 'download-9' } as any];
    component.download_uids = ['download-8', 'download-9'];

    const removed = component.removeDownloadFromCurrentDownloads({ uid: 'download-8' } as any);

    expect(removed).toBe(true);
    expect(component.download_uids).toEqual(['download-9']);
    expect(component.current_download && component.current_download.uid).toBe('download-9');
  });

  it('shows playlist download option for single YouTube URL with list param', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0&list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL&index=6';

    expect(component.hasPlaylistUrlInInput()).toBe(true);
    expect(component.hasAdditionalDownloadMenuActions()).toBe(true);
  });

  it('shows channel search playlist option for YouTube channel search URLs', () => {
    component.url = 'https://www.youtube.com/@SimonizeShow/search?query=TBC';

    expect(component.hasChannelSearchPlaylistUrlInInput()).toBe(true);
    expect(component.hasAdditionalDownloadMenuActions()).toBe(true);
  });

  it('does not show playlist download option for non-playlist URL', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0';

    expect(component.hasPlaylistUrlInInput()).toBe(false);
  });

  it('keeps download menu visible when sponsorblock downloads are enabled', () => {
    component.sponsorBlockDownloadsEnabled = true;
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0';

    expect(component.hasAdditionalDownloadMenuActions()).toBe(true);
  });

  it('toggles audio-only mode from the download menu', () => {
    component.audioOnly = false;
    component.selectedQuality = 'best';
    component.selectedSubtitleLanguage = 'en';
    (component as any).selectedSubtitleSource = 'automatic';
    vi.spyOn(component, 'argsChanged').mockReturnValue(undefined);

    component.toggleAudioOnlyFromMenu();

    expect(component.audioOnly).toBe(true);
    expect(component.selectedQuality).toBe('');
    expect(component.selectedSubtitleLanguage).toBe('');
    expect((component as any).selectedSubtitleSource).toBe('');
    expect(localStorage.getItem('audioOnly')).toBe('true');
    expect(component.argsChanged).toHaveBeenCalled();
  });

  it('toggles autoplay from the download menu', () => {
    component.autoplay = false;

    component.toggleAutoplayFromMenu();

    expect(component.autoplay).toBe(true);
    expect(localStorage.getItem('autoplay')).toBe('true');
  });

  it('builds language-aware video selectors from loaded formats', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'none', abr: 128, format_id: 'audio-en', ext: 'm4a', language: 'en', language_preference: 10, filesize: 100 },
      { vcodec: 'none', abr: 128, format_id: 'audio-es', ext: 'm4a', language: 'es', filesize: 90 },
      { vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, format_id: 'video-only-1080', ext: 'mp4', filesize: 1000 },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-merged-1080', ext: 'mp4', filesize: 1100 }
    ]);

    component.url = 'https://example.com/video';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = parsedFormats.video[0];
    component.selectedAudioLanguage = 'es';

    expect(parsedFormats.audio_languages.map(option => option.value)).toEqual(['en', 'es']);
    expect(component.getSelectedVideoFormat()).toBe('video-only-1080+audio-es');
  });

  it('prefers muxed language-specific video formats when available', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, format_id: 'video-only-1080', ext: 'mp4', filesize: 1000 },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-en-1080', ext: 'mp4', language: 'en', filesize: 1100 },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-fr-1080', ext: 'mp4', language: 'fr', filesize: 1150 }
    ]);

    component.url = 'https://example.com/muxed-video';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = parsedFormats.video[0];
    component.selectedAudioLanguage = 'fr';

    expect(parsedFormats.audio_languages.map(option => option.value)).toEqual(['en', 'fr']);
    expect(component.getSelectedVideoFormat()).toBe('video-fr-1080');
  });

  it('falls back to the best selected language audio track when the chosen bitrate is unavailable', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'none', abr: 128, format_id: 'audio-en-128', ext: 'm4a', language: 'en', language_preference: 10, filesize: 100 },
      { vcodec: 'none', abr: 96, format_id: 'audio-es-96', ext: 'm4a', language: 'es', filesize: 75 }
    ]);

    component.url = 'https://example.com/audio';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = parsedFormats.audio.find(option => option.key === '128K');
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedAudioFormat()).toBe('audio-es-96');
  });

  it('falls back to the best muxed language format for audio downloads when no audio-only dub exists', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'none', abr: 128, format_id: 'audio-en-128', ext: 'm4a', language: 'en', language_preference: 10, filesize: 100 },
      { vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, format_id: 'video-fr-720', ext: 'mp4', language: 'fr', filesize: 400 }
    ]);

    component.url = 'https://example.com/audio-fallback';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = parsedFormats.audio.find(option => option.key === '128K');
    component.selectedAudioLanguage = 'fr';

    expect(component.getSelectedAudioFormat()).toBe('video-fr-720');
  });

  it('uses the best selected-language audio format when Best is still selected', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'none', abr: 128, format_id: 'audio-en-128', ext: 'm4a', language: 'en', language_preference: 10, filesize: 100 },
      { vcodec: 'none', abr: 96, format_id: 'audio-es-96', ext: 'm4a', language: 'es', filesize: 75 }
    ]);

    component.url = 'https://example.com/audio-best';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = '';
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedAudioFormat()).toBe('audio-es-96');
  });

  it('uses the best muxed selected-language video format when Best is still selected', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'avc1', acodec: 'none', height: 1440, fps: 30, format_id: 'video-only-1440', ext: 'mp4', filesize: 1400 },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-es-1080', ext: 'mp4', language: 'es', filesize: 1100 },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-en-1080', ext: 'mp4', language: 'en', filesize: 1120 }
    ]);

    component.url = 'https://example.com/video-best';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = '';
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedVideoFormat()).toBe('video-es-1080');
  });

  it('uses the highest resolution muxed selected-language video format when dubbed formats are listed low-to-high', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'avc1', acodec: 'mp4a', height: 144, fps: 30, format_id: 'video-es-144', ext: 'mp4', language: 'es' },
      { vcodec: 'avc1', acodec: 'mp4a', height: 360, fps: 30, format_id: 'video-es-360', ext: 'mp4', language: 'es' },
      { vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, format_id: 'video-es-720', ext: 'mp4', language: 'es' },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-es-1080', ext: 'mp4', language: 'es' }
    ]);

    component.url = 'https://example.com/video-best-ordered';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = '';
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedVideoFormat()).toBe('video-es-1080');
  });

  it('keeps the selected quality when a muxed dubbed format exists at that resolution', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, format_id: 'video-es-720', ext: 'mp4', language: 'es' },
      { vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-es-1080', ext: 'mp4', language: 'es' }
    ]);

    component.url = 'https://example.com/video-selected-quality-muxed';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = parsedFormats.video.find(option => option.key === '720p30');
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedVideoFormat()).toBe('video-es-720');
  });

  it('keeps the selected quality when pairing video-only output with the selected language audio', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'none', abr: 96, format_id: 'audio-es-96', ext: 'm4a', language: 'es', filesize: 75 },
      { vcodec: 'avc1', acodec: 'none', height: 720, fps: 30, format_id: 'video-only-720', ext: 'mp4', filesize: 700 },
      { vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, format_id: 'video-only-1080', ext: 'mp4', filesize: 1000 }
    ]);

    component.url = 'https://example.com/video-selected-quality-split';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = parsedFormats.video.find(option => option.key === '720p30');
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedVideoFormat()).toBe('video-only-720+audio-es-96');
  });

  it('uses the highest quality video plus selected-language audio when Best is still selected and no muxed dub exists', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([
      { vcodec: 'none', abr: 128, format_id: 'audio-en-128', ext: 'm4a', language: 'en', language_preference: 10, filesize: 100 },
      { vcodec: 'none', abr: 96, format_id: 'audio-es-96', ext: 'm4a', language: 'es', filesize: 75 },
      { vcodec: 'avc1', acodec: 'none', height: 1440, fps: 30, format_id: 'video-only-1440', ext: 'mp4', filesize: 1400 }
    ]);

    component.url = 'https://example.com/video-best-split';
    component.cachedAvailableFormats[component.url] = { formats: parsedFormats };
    component.selectedQuality = '';
    component.selectedAudioLanguage = 'es';

    expect(component.getSelectedVideoFormat()).toBe('video-only-1440+audio-es-96');
  });

  it('builds subtitle options from manual subtitles and automatic captions in the existing info probe', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([{ vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-1080', ext: 'mp4' }], {
      subtitles: {
        fr: [{ ext: 'srt' }],
        live_chat: [{ ext: 'json' }]
      },
      automatic_captions: {
        es: [{ ext: 'vtt' }],
        fr: [{ ext: 'vtt' }],
        en: []
      }
    });

    expect(parsedFormats.subtitle_languages.map(option => ({
      value: option.value,
      source: option.source,
      hasManual: option.hasManual,
      hasAutomatic: option.hasAutomatic
    }))).toEqual([
      { value: 'fr', source: 'manual', hasManual: true, hasAutomatic: true },
      { value: 'es', source: 'automatic', hasManual: false, hasAutomatic: true }
    ]);
  });

  it('filters translated automatic caption targets down to the real source language', () => {
    const parsedFormats: any = component.getAudioAndVideoFormats([{ vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, format_id: 'video-1080', ext: 'mp4' }], {
      subtitles: {},
      automatic_captions: {
        'en-orig': [{ url: 'https://www.youtube.com/api/timedtext?lang=en&fmt=vtt', ext: 'vtt', name: 'English (Original)' }],
        en: [{ url: 'https://www.youtube.com/api/timedtext?lang=en&fmt=vtt', ext: 'vtt', name: 'English' }],
        fr: [{ url: 'https://www.youtube.com/api/timedtext?lang=en&tlang=fr&fmt=vtt', ext: 'vtt', name: 'French' }],
        es: [{ url: 'https://www.youtube.com/api/timedtext?lang=en&tlang=es&fmt=vtt', ext: 'vtt', name: 'Spanish' }]
      }
    });

    expect(parsedFormats.subtitle_languages.map(option => ({
      value: option.value,
      source: option.source
    }))).toEqual([
      { value: 'en', source: 'automatic' }
    ]);
  });

  it('passes selected subtitle language and source through the main download request', () => {
    const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-subtitles' } }));
    component.url = 'https://example.com/subtitles';
    component.cachedAvailableFormats[component.url] = {
      formats: {
        subtitle_languages: [
          { value: 'es', label: 'Spanish (auto)', source: 'automatic', hasManual: false, hasAutomatic: true }
        ]
      }
    };
    component.onSelectedSubtitleLanguageChanged('es');

    component.downloadClicked();

    expect(download_file_spy).toHaveBeenCalled();
    expect(vi.mocked(download_file_spy).mock.calls[0][13]).toBe('es');
    expect(vi.mocked(download_file_spy).mock.calls[0][14]).toBe('automatic');
  });

  it('keeps automatic subtitle selection when the watch URL is sanitized before download', () => {
    const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-subtitles-sanitized' } }));
    component.url = 'https://www.youtube.com/watch?v=SsKT0s5J8ko&list=RDBuNBLjJzRoo&index=20';
    component.cachedAvailableFormats[component.url] = {
      formats: {
        subtitle_languages: [
          { value: 'en', label: 'English (auto)', source: 'automatic', hasManual: false, hasAutomatic: true }
        ]
      }
    };
    component.onSelectedSubtitleLanguageChanged('en');

    component.downloadClicked();

    expect(download_file_spy).toHaveBeenCalled();
    expect(vi.mocked(download_file_spy).mock.calls[0][0]).toBe('https://www.youtube.com/watch?v=SsKT0s5J8ko');
    expect(vi.mocked(download_file_spy).mock.calls[0][13]).toBe('en');
    expect(vi.mocked(download_file_spy).mock.calls[0][14]).toBe('automatic');
  });

  it('preserves the selected subtitle source even if cached formats are unavailable at download time', () => {
    const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-subtitles-sticky-source' } }));
    component.url = 'https://www.youtube.com/watch?v=SsKT0s5J8ko&list=RDBuNBLjJzRoo&index=20';
    component.cachedAvailableFormats[component.url] = {
      formats: {
        subtitle_languages: [
          { value: 'en', label: 'English (auto)', source: 'automatic', hasManual: false, hasAutomatic: true }
        ]
      }
    };

    component.onSelectedSubtitleLanguageChanged('en');
    component.cachedAvailableFormats = Object.create(null);

    component.downloadClicked();

    expect(download_file_spy).toHaveBeenCalled();
    expect(vi.mocked(download_file_spy).mock.calls[0][13]).toBe('en');
    expect(vi.mocked(download_file_spy).mock.calls[0][14]).toBe('automatic');
  });

  it('does not allow subtitle selection in audio-only mode', () => {
    component.url = 'https://example.com/audio-only';
    component.audioOnly = true;
    component.cachedAvailableFormats[component.url] = {
      formats: {
        subtitle_languages: [
          { value: 'fr', label: 'French', source: 'manual', hasManual: true, hasAutomatic: false }
        ]
      }
    };

    expect(component.canSelectSubtitleLanguage()).toBe(false);
  });

  it('maps playlist menu action to canonical playlist URL', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0&list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL&index=6';
    const download_spy = vi.spyOn(component, 'downloadClicked').mockReturnValue(undefined);

    component.downloadPlaylistClicked();

    expect(download_spy).toHaveBeenCalledWith(false, 'https://www.youtube.com/playlist?list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL', false);
  });

  it('falls back to normal download when playlist action is unavailable', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0';
    const download_spy = vi.spyOn(component, 'downloadClicked').mockReturnValue(undefined);

    component.downloadPlaylistClicked();

    expect(download_spy).toHaveBeenCalledWith();
  });

  it('maps channel search menu action to the playlist-style path', () => {
    component.url = 'https://www.youtube.com/@SimonizeShow/search?query=TBC';
    const download_spy = vi.spyOn(component, 'downloadClicked').mockReturnValue(undefined);

    component.downloadChannelSearchPlaylistClicked();

    expect(download_spy).toHaveBeenCalledWith(false, 'https://www.youtube.com/@SimonizeShow/search?query=TBC', false, true);
  });

  it('keeps main download as single-video for watch URLs that include list param', () => {
    const download_file_spy = vi.fn().mockName('downloadFile').mockReturnValue(of({ download: { uid: 'queued-1' } }));
    (component as any).postsService.downloadFile = download_file_spy;
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0&list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL&index=6';
    component.autoplay = true;

    component.downloadClicked();

    const called_url = vi.mocked(download_file_spy).mock.calls[0][0];
    expect(called_url).toBe('https://www.youtube.com/watch?v=wOWhfNB_r-0');
  });

  it('skips format probing for channel search playlist URLs', () => {
    const channel_search_url = 'https://www.youtube.com/@SimonizeShow/search?query=TBC';
    const get_file_formats_spy = vi.fn().mockName('getFileFormats').mockReturnValue(of({ result: null }));
    (component as any).postsService.getFileFormats = get_file_formats_spy;

    component.getURLInfo(channel_search_url);

    expect(get_file_formats_spy).not.toHaveBeenCalled();
    expect(component.cachedAvailableFormats[channel_search_url]['formats_failed']).toBe(true);
  });

  it('probes watch urls with playlist params as a sanitized single-video url', () => {
    const watch_url_with_playlist = 'https://www.youtube.com/watch?v=K_9tX4eHztY&list=RDBuNBLjJzRoo&index=7';
    const get_file_formats_spy = vi.fn().mockName('getFileFormats').mockReturnValue(of({ result: { formats: [] } }));
    (component as any).postsService.getFileFormats = get_file_formats_spy;
    const parse_formats_spy = vi.spyOn(component, 'getAudioAndVideoFormats').mockReturnValue({ video: [], audio: [], subtitle_languages: [], audio_languages: [] } as any);

    component.getURLInfo(watch_url_with_playlist);

    expect(get_file_formats_spy).toHaveBeenCalledWith('https://www.youtube.com/watch?v=K_9tX4eHztY');
    expect(parse_formats_spy).toHaveBeenCalled();
    expect(component.cachedAvailableFormats[watch_url_with_playlist]['formats_loading']).toBe(false);
  });

  describe('download option pickers', () => {
    const url = 'https://example.com/watch/abc';

    beforeEach(() => {
      component.url = url;
    });

    it('offers Best, then each format the link was found to have with the size it would download at', () => {
      const format_1080 = { key: '1080p', expected_filesize: 640_000_000 };
      const format_720 = { key: '720p' };
      component.cachedAvailableFormats[url] = { formats_loading: false, formats: { video: [format_1080, format_720], audio: [{ key: '160kbps' }] } };

      expect(component.qualityPickerOptions).toEqual([
        { value: '', label: 'Best' },
        { value: format_1080, label: '1080p', detail: component.humanFileSize(640_000_000) },
        { value: format_720, label: '720p', detail: null }
      ]);

      component.audioOnly = true;
      expect(component.qualityPickerOptions.map(option => option.label)).toEqual(['Best', '160kbps']);
    });

    it('falls back to the usual resolutions when the link could not be looked up', () => {
      component.cachedAvailableFormats[url] = { formats_loading: false, formats_failed: true };

      expect(component.qualityPickerOptions.map(option => option.value)).toEqual(['', ...component.qualityOptions.video.map(quality => quality.value)]);
    });

    it('offers only Best while the link is still being looked up', () => {
      component.cachedAvailableFormats[url] = { formats_loading: true };

      expect(component.formatsLoading).toBe(true);
      expect(component.qualityPickerOptions).toEqual([{ value: '', label: 'Best' }]);
    });

    it('lists the languages found after the default', () => {
      component.cachedAvailableFormats[url] = {
        formats_loading: false,
        formats: {
          video: [],
          audio: [],
          audio_languages: [{ value: 'es', label: 'Spanish' }],
          subtitle_languages: [{ value: 'fr', label: 'French', source: 'manual', hasManual: true, hasAutomatic: false }]
        }
      };

      expect(component.audioLanguagePickerOptions).toEqual([{ value: '', label: 'Default' }, { value: 'es', label: 'Spanish' }]);
      expect(component.subtitleLanguagePickerOptions).toEqual([{ value: '', label: 'Default' }, { value: 'fr', label: 'French' }]);
    });
  });

  it('shows the playlist shortcut only when the library is on the playlists tab', () => {
    component.mediaLibrary = {
      activeLibraryTab: 1,
      openCreatePlaylistDialog: () => { }
    } as any;

    expect(component.showCreatePlaylistShortcut).toBe(true);

    component.mediaLibrary.activeLibraryTab = 0;
    expect(component.showCreatePlaylistShortcut).toBe(false);

    component.mediaLibrary = null;
    expect(component.showCreatePlaylistShortcut).toBe(false);
  });

  it('delegates playlist creation to the media library component', () => {
    const open_dialog_spy = vi.fn().mockName('openCreatePlaylistDialog');
    component.mediaLibrary = {
      activeLibraryTab: 1,
      openCreatePlaylistDialog: open_dialog_spy
    } as any;

    component.openCreatePlaylistDialog();

    expect(open_dialog_spy).toHaveBeenCalled();
  });

  describe('advanced download mode', () => {
    const ADVANCED_STORAGE_KEYS = [
      'advancedMode', 'customArgsEnabled', 'replaceArgs', 'customOutputEnabled',
      'youtubeAuthEnabled', 'customArgs', 'customOutput', 'youtubeUsername'
    ];

    // downloadFile(url, type, quality, qualityConfig, customArgs, additionalArgs,
    //              customOutput, username, password, cropFileSettings, ...)
    const CUSTOM_ARGS_INDEX = 4;
    const ADDITIONAL_ARGS_INDEX = 5;
    const CUSTOM_OUTPUT_INDEX = 6;
    const USERNAME_INDEX = 7;
    const PASSWORD_INDEX = 8;
    const CROP_SETTINGS_INDEX = 9;

    beforeEach(() => {
      for (const key of ADVANCED_STORAGE_KEYS)
        localStorage.removeItem(key);
      component.allowAdvancedDownload = true;
      component.url = 'https://www.youtube.com/watch?v=advancedmode';
    });

    afterEach(() => {
      for (const key of ADVANCED_STORAGE_KEYS)
        localStorage.removeItem(key);
    });

    function fillAdvancedOptions(): void {
      component.customArgsEnabled = true;
      component.customArgs = '--write-thumbnail';
      component.customOutputEnabled = true;
      component.customOutput = 'custom/path';
      component.youtubeAuthEnabled = true;
      component.youtubeUsername = 'user';
      component.youtubePassword = 'secret';
      component.cropFile = true;
      component.cropFileStart = 10;
      component.cropFileEnd = 40;
    }

    it('starts closed and is not active until opened', () => {
      expect(component.advancedMode).toBe(false);
      expect(component.isAdvancedModeActive()).toBe(false);
    });

    it('opens and closes through the download menu toggle', () => {
      component.toggleAdvancedMode();
      expect(component.advancedMode).toBe(true);
      expect(component.isAdvancedModeActive()).toBe(true);
      expect(localStorage.getItem('advancedMode')).toBe('true');

      component.toggleAdvancedMode();
      expect(component.advancedMode).toBe(false);
      expect(localStorage.getItem('advancedMode')).toBe('false');
    });

    it('is never active when the feature is not permitted', () => {
      component.advancedMode = true;
      component.allowAdvancedDownload = false;

      expect(component.isAdvancedModeActive()).toBe(false);
    });

    it('refuses to open when the feature is not permitted', () => {
      component.allowAdvancedDownload = false;

      component.toggleAdvancedMode();

      expect(component.advancedMode).toBe(false);
    });

    it('clears every advanced option when closed', () => {
      component.toggleAdvancedMode();
      fillAdvancedOptions();

      component.closeAdvancedMode();

      expect(component.customArgsEnabled).toBe(false);
      expect(component.customArgs).toBeNull();
      expect(component.replaceArgs).toBe(false);
      expect(component.customOutputEnabled).toBe(false);
      expect(component.customOutput).toBeNull();
      expect(component.youtubeAuthEnabled).toBe(false);
      expect(component.youtubeUsername).toBeNull();
      expect(component.youtubePassword).toBeNull();
      expect(component.cropFile).toBe(false);
      expect(component.cropFileStart).toBeNull();
      expect(component.cropFileEnd).toBeNull();
    });

    it('passes advanced options through the download request while open', () => {
      const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-advanced' } }));
      component.toggleAdvancedMode();
      fillAdvancedOptions();

      component.downloadClicked();

      expect(download_file_spy).toHaveBeenCalled();
      const args = vi.mocked(download_file_spy).mock.calls[0];
      // customArgs is only used to replace args; otherwise they are additional
      expect(args[CUSTOM_ARGS_INDEX]).toBeNull();
      expect(args[ADDITIONAL_ARGS_INDEX]).toBe('--write-thumbnail');
      expect(args[CUSTOM_OUTPUT_INDEX]).toBe('custom/path');
      expect(args[USERNAME_INDEX]).toBe('user');
      expect(args[PASSWORD_INDEX]).toBe('secret');
      expect(args[CROP_SETTINGS_INDEX]).toEqual({ cropFileStart: 10, cropFileEnd: 40 });
    });

    it('sends custom args as replacement args when replace is checked', () => {
      const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-replace' } }));
      component.toggleAdvancedMode();
      fillAdvancedOptions();
      component.replaceArgs = true;

      component.downloadClicked();

      const args = vi.mocked(download_file_spy).mock.calls[0];
      expect(args[CUSTOM_ARGS_INDEX]).toBe('--write-thumbnail');
      expect(args[ADDITIONAL_ARGS_INDEX]).toBeNull();
    });

    it('sends no advanced options once advanced mode is closed', () => {
      const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-closed' } }));
      component.toggleAdvancedMode();
      fillAdvancedOptions();
      component.closeAdvancedMode();

      component.downloadClicked();

      const args = vi.mocked(download_file_spy).mock.calls[0];
      expect(args[CUSTOM_ARGS_INDEX]).toBeNull();
      expect(args[ADDITIONAL_ARGS_INDEX]).toBeNull();
      expect(args[CUSTOM_OUTPUT_INDEX]).toBeNull();
      expect(args[USERNAME_INDEX]).toBeNull();
      expect(args[PASSWORD_INDEX]).toBeNull();
      expect(args[CROP_SETTINGS_INDEX]).toBeNull();
    });

    it('ignores stale advanced values that were never cleared', () => {
      const download_file_spy = vi.spyOn((component as any).postsService, 'downloadFile').mockReturnValue(of({ download: { uid: 'queued-stale' } }));
      // simulates values surviving in component state without the panel being open
      fillAdvancedOptions();
      component.advancedMode = false;

      component.downloadClicked();

      const args = vi.mocked(download_file_spy).mock.calls[0];
      expect(args[ADDITIONAL_ARGS_INDEX]).toBeNull();
      expect(args[CUSTOM_OUTPUT_INDEX]).toBeNull();
      expect(args[USERNAME_INDEX]).toBeNull();
      expect(args[PASSWORD_INDEX]).toBeNull();
      expect(args[CROP_SETTINGS_INDEX]).toBeNull();
    });

    it('keeps the simulated command in sync with what a download would send', () => {
      const generate_args_spy = vi.spyOn((component as any).postsService, 'generateArgs').mockReturnValue(of({ args: [] }));
      fillAdvancedOptions();
      component.advancedMode = false;

      component.getSimulatedOutput();

      const args = vi.mocked(generate_args_spy).mock.calls[0];
      expect(args[CUSTOM_ARGS_INDEX]).toBeNull();
      expect(args[ADDITIONAL_ARGS_INDEX]).toBeNull();
      expect(args[CUSTOM_OUTPUT_INDEX]).toBeNull();
      expect(args[CROP_SETTINGS_INDEX]).toBeNull();
    });

    it('does not restore advanced options from storage without the user permission', async () => {
      localStorage.setItem('advancedMode', 'true');
      localStorage.setItem('customArgsEnabled', 'true');
      localStorage.setItem('customArgs', '--stale-arg');
      (component as any).postsService.hasPermission = (permission: string) => permission !== 'advanced_download';

      await component.loadConfig();

      expect(component.allowAdvancedDownload).toBe(false);
      expect(component.advancedMode).toBe(false);
      expect(component.isAdvancedModeActive()).toBe(false);
      expect(component.customArgsEnabled).toBe(false);
      expect(component.customArgs).toBeNull();
    });

    it('restores advanced options from storage when advanced mode was left open', async () => {
      localStorage.setItem('advancedMode', 'true');
      localStorage.setItem('customArgsEnabled', 'true');
      localStorage.setItem('customArgs', '--restored-arg');

      await component.loadConfig();

      expect(component.advancedMode).toBe(true);
      expect(component.customArgsEnabled).toBe(true);
      expect(component.customArgs).toBe('--restored-arg');
    });

    it('is available on permission alone, with no global setting to enable', async () => {
      // the removed allow_advanced_download setting must not be consulted, even if a stale
      // copy is still present in a config that has not been migrated yet
      (component as any).postsService.config['Advanced']['allow_advanced_download'] = false;

      await component.loadConfig();

      expect(component.allowAdvancedDownload).toBe(true);
    });
  });
});
