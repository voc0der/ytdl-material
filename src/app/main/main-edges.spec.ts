import { of, Subject, throwError } from 'rxjs';
import { MainComponent } from './main.component';

// The home page's less common turns: formats that tie, addresses in their other shapes, a
// retry the server could not queue, and downloads the page only knows by id.
describe('Home page edges', () => {
  let component: MainComponent;
  let posts: any;
  let dialog: any;

  beforeEach(() => {
    posts = {
      config: { Advanced: {}, Downloader: {}, Extra: {}, API: {} },
      hasPermission: () => true,
      config_reloaded: new Subject(),
      service_initialized: new Subject(),
      files_changed: { next: vi.fn() },
      playlists_changed: { next: vi.fn() },
      openSnackBar: vi.fn(),
      getFileFormats: vi.fn(),
      generateArgs: vi.fn().mockReturnValue(of({ args: [] }))
    };
    dialog = { open: vi.fn() };
    component = new MainComponent(posts, {} as any, {} as any, {} as any, dialog, {} as any, {} as any);
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.restoreAllMocks();
  });

  it('reloads the library rather than playing what was downloaded when autoplay is off', () => {
    component.autoplay = false;
    component.downloadOnlyMode = false;

    component.downloadHelper({ uid: 'mix' } as any, 'video', true);

    expect(posts.files_changed.next).toHaveBeenCalledWith(true);
    expect(posts.playlists_changed.next).toHaveBeenCalledWith(true);
  });

  it('marks the formats as failed when they cannot be looked up', () => {
    posts.getFileFormats.mockReturnValue(throwError(() => new Error('offline')));
    component.getURLInfo('https://example.test/clip');
    expect(component.cachedAvailableFormats['https://example.test/clip']['formats_failed']).toBe(true);
  });

  it('reads the video id out of the site\'s short, embedded and old-style addresses', () => {
    const sanitize = (url: string) => (component as any).sanitizeYouTubeWatchUrl(url);
    expect(sanitize('https://www.youtube.com/shorts/abc123')).toBe('https://www.youtube.com/watch?v=abc123');
    expect(sanitize('https://www.youtube.com/embed/abc123?start=4')).toBe('https://www.youtube.com/watch?v=abc123');
    expect(sanitize('https://www.youtube.com/vi/abc123')).toBe('https://www.youtube.com/watch?v=abc123');
    expect(sanitize('https://www.youtube.com/shorts/')).toBe('https://www.youtube.com/shorts/');
    expect(sanitize('https://www.youtube.com/feed/library')).toBe('https://www.youtube.com/feed/library');
  });

  it('finds the formats looked up for the same video under another form of its address', () => {
    const lookup = (url: string) => (component as any).getCachedFormatsEntry(url);
    const entry = { formats: { video: [] } };
    component.cachedAvailableFormats['https://www.youtube.com/watch?v=abc123'] = entry;
    expect(lookup('https://www.youtube.com/watch?v=abc123&t=30')).toBe(entry);

    delete component.cachedAvailableFormats['https://www.youtube.com/watch?v=abc123'];
    component.cachedAvailableFormats['https://youtu.be/abc123'] = null;
    component.cachedAvailableFormats['https://www.youtube.com/watch?v=abc123&feature=share'] = entry;
    expect(lookup('https://www.youtube.com/watch?v=abc123&t=30')).toBe(entry);
    expect(lookup('https://www.youtube.com/watch?v=other')).toBeNull();
  });

  it('takes the subtitle kind from the language picked when no kind was chosen', () => {
    component.url = 'https://example.test/clip';
    component.cachedAvailableFormats[component.url] = { formats: { subtitle_languages: [
      { value: 'en', label: 'English', source: 'automatic', hasManual: false, hasAutomatic: true }
    ] } };
    component.selectedSubtitleLanguage = 'en';
    component.selectedSubtitleSource = 'any' as any;
    expect((component as any).getSelectedSubtitleType()).toBe('automatic');
    component.selectedSubtitleLanguage = 'de';
    expect((component as any).getSelectedSubtitleType()).toBeNull();
  });

  it('has no default video for a language with neither a combined format nor audio to merge', () => {
    component.url = 'https://example.test/clip';
    component.selectedAudioLanguage = 'fr';
    component.cachedAvailableFormats[component.url] = { formats: { video: [{ format_id: 'video-only' }], best_merge_audio_formats_by_language: {} } };
    expect((component as any).getDefaultVideoFormatForSelection()).toBeNull();
  });

  describe('sorting formats', () => {
    const parse = (formats: any[]) => (component as any).getAudioAndVideoFormats(formats, {});

    it('keeps the first of two formats that tie, but takes an m4a or mp4 over another kind', () => {
      const parsed = parse([
        { format_id: 'm4a', vcodec: 'none', abr: 128, ext: 'm4a', filesize: 100 },
        { format_id: 'webm-audio', vcodec: 'none', abr: 128, ext: 'webm', filesize: 100 },
        { format_id: 'm4a-again', vcodec: 'none', abr: 128, ext: 'm4a', filesize: 100 },
        { format_id: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, fps: 30, ext: 'mp4', filesize: 500 },
        { format_id: 'webm-video', vcodec: 'vp9', acodec: 'none', height: 720, fps: 30, ext: 'webm', filesize: 500 },
        { format_id: 'mp4-again', vcodec: 'avc1', acodec: 'none', height: 720, fps: 30, ext: 'mp4', filesize: 500 }
      ]);
      expect(parsed.audio_formats_by_key['128K'].default.format_id).toBe('m4a');
      expect(parsed.video_formats_by_key['720p30'].default.format_id).toBe('mp4');
    });

    it('pairs a combined format with the video-only stream of the same quality', () => {
      const parsed = parse([
        { format_id: 'combined', vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30, ext: 'mp4', filesize: 900 },
        { format_id: 'video-only', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, ext: 'mp4', filesize: 800 }
      ]);
      expect(parsed.video_formats_by_key['1080p30'].default).toEqual(expect.objectContaining({ format_id: 'combined', video_only_format_id: 'video-only' }));
    });

    it('gives a language\'s own combined format the video-only stream found before it', () => {
      const parsed = parse([
        { format_id: 'video-only', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, ext: 'mp4', filesize: 800 },
        { format_id: 'english', vcodec: 'avc1', acodec: 'mp4a', language: 'en', height: 1080, fps: 30, ext: 'mp4', filesize: 950 },
        { format_id: 'french', vcodec: 'avc1', acodec: 'mp4a', language: 'fr', height: 1080, fps: 30, ext: 'mp4', filesize: 900 }
      ]);
      expect(parsed.video_formats_by_key['1080p30'].default.format_id).toBe('english');
      expect(parsed.video_formats_by_key['1080p30'].by_language.fr).toEqual(expect.objectContaining({ format_id: 'french', video_only_format_id: 'video-only' }));
    });
  });

  it('shows a language code as it is when it cannot be named', () => {
    expect((component as any).getLanguageLabel('not a language')).toBe('not a language');
  });

  it('keeps the custom arguments edited in their dialog, and the old ones when it is dismissed', () => {
    const closed = new Subject<string | null>();
    dialog.open.mockReturnValue({ afterClosed: () => closed });
    component.customArgs = '--old';

    component.openArgsModifierDialog();
    expect(dialog.open.mock.calls[0][1].data.initial_args).toBe('--old');
    closed.next(null);
    expect(component.customArgs).toBe('--old');
    closed.next('--embed-subs');
    expect(component.customArgs).toBe('--embed-subs');
  });

  it('has nothing to look up when no download is being followed', () => {
    posts.getCurrentDownload = vi.fn();
    component.current_download = null;
    component.getCurrentDownload();
    expect(posts.getCurrentDownload).not.toHaveBeenCalled();
  });

  it('says so when the server could not queue a retried duplicate', () => {
    const skipped = { uid: 'skipped', finished: true, duplicate_skip_only: true, file_uids: ['existing'], type: 'video', title: 'Existing' };
    posts.getCurrentDownload = () => of({ download: skipped });
    posts.retryDuplicateDownload = vi.fn().mockReturnValue(of({ download: null }));
    dialog.open.mockReturnValue({ afterClosed: () => of('copy') });
    component.current_download = { uid: 'skipped' } as any;
    component.downloads = [component.current_download];
    component.download_uids = ['skipped'];

    component.getCurrentDownload();

    expect(posts.openSnackBar).toHaveBeenCalledWith('Could not queue the download. Try again.');
    expect(component.download_uids).toEqual([]);
  });

  it('follows a queued download it knows only by id, and forgets one it never had', () => {
    component.downloads = [];
    component.download_uids = ['', 'known-by-id'];
    component.current_download = null;
    expect(component.removeDownloadFromCurrentDownloads({ uid: 'never-had' } as any)).toBe(false);
    expect(component.current_download).toEqual({ uid: 'known-by-id' });
  });

  it('writes a size under a kilobyte in bytes', () => {
    expect(component.humanFileSize(512)).toBe('512 B');
  });
});
