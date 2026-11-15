import { of, Subject } from 'rxjs';
import { MainComponent } from './main.component';

describe('Download format selection', () => {
  let component: MainComponent;
  let posts: any;
  let formats: any;

  beforeEach(() => {
    posts = { config: { Advanced: {}, Downloader: {}, Extra: {}, API: {} }, hasPermission: () => true,
      config_reloaded: new Subject(), service_initialized: new Subject(), generateArgs: vi.fn().mockReturnValue(of({ args: [] })) };
    component = new MainComponent(posts, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    component.url = 'https://example.test/clip';
    formats = { audio: [], video: [], audio_languages: [{ value: 'fr', label: 'French' }], subtitle_languages: [
      { value: 'en', label: 'English', source: 'manual', hasManual: true, hasAutomatic: true }
    ] };
    component.cachedAvailableFormats[component.url] = { formats };
  });
  afterEach(() => { component.ngOnDestroy(); localStorage.clear(); vi.restoreAllMocks(); });

  it('selects the requested language at the chosen bitrate, then falls back through available sources', () => {
    component.selectedQuality = { key: '128K' };
    component.selectedAudioLanguage = 'fr';
    formats.audio_formats_by_key = { '128K': { default: { format_id: 'default' }, by_language: { fr: { format_id: 'exact' } } } };
    formats.best_audio_formats_by_language = { fr: { format_id: 'best-fr' } };
    formats.best_muxed_formats_by_language = { fr: { format_id: 'muxed-fr' } };
    formats.best_audio_format = { format_id: 'best' };
    expect(component.getSelectedAudioFormat()).toBe('exact');
    delete formats.audio_formats_by_key['128K'].by_language.fr;
    expect(component.getSelectedAudioFormat()).toBe('best-fr');
    delete formats.best_audio_formats_by_language.fr;
    expect(component.getSelectedAudioFormat()).toBe('muxed-fr');
    delete formats.best_muxed_formats_by_language.fr;
    expect(component.getSelectedAudioFormat()).toBe('default');
    delete formats.audio_formats_by_key;
    formats.best_audio_formats_by_language.fr = { format_id: 'best-fr' };
    expect(component.getSelectedAudioFormat()).toBe('best-fr');
    delete formats.best_audio_formats_by_language.fr;
    formats.best_muxed_formats_by_language.fr = { format_id: 'muxed-fr' };
    expect(component.getSelectedAudioFormat()).toBe('muxed-fr');
    delete formats.best_muxed_formats_by_language.fr;
    expect(component.getSelectedAudioFormat()).toBe('best');
    formats.best_audio_format = null;
    expect(component.getSelectedAudioFormat()).toBeNull();
  });

  it('selects a language-specific video or the best matching default and merge audio', () => {
    component.selectedQuality = { key: '720p30', format_id: 'selected' };
    component.selectedAudioLanguage = 'fr';
    formats.video_formats_by_key = { '720p30': { default: { format_id: 'default', acodec: 'none' }, by_language: { fr: { format_id: 'french', language: 'fr', acodec: 'aac' } } } };
    expect(component.getSelectedVideoFormat()).toBe('french');
    delete formats.video_formats_by_key['720p30'].by_language.fr;
    formats.best_merge_audio_formats_by_language = { fr: { format_id: 'audio-fr' } };
    expect(component.getSelectedVideoFormat()).toBe('default+audio-fr');
    component.selectedAudioLanguage = '';
    formats.best_merge_audio_format = { format_id: 'audio' };
    expect(component.getSelectedVideoFormat()).toBe('default+audio');
    formats.video_formats_by_key = {};
    formats.best_merge_audio_format = null;
    expect(component.getSelectedVideoFormat()).toBe('selected');
    component.selectedQuality = null;
    expect(component.getSelectedVideoFormat()).toBeNull();
  });

  it('offers language controls only when formats are ready and the selected media supports them', () => {
    expect(component.canSelectAudioLanguage()).toBe(true);
    expect(component.canSelectSubtitleLanguage()).toBe(true);
    expect(component.audioLanguagePickerOptions.at(-1)).toEqual({ value: 'fr', label: 'French' });
    expect(component.subtitleLanguagePickerOptions.at(-1)).toEqual({ value: 'en', label: 'English' });
    component.cachedAvailableFormats[component.url].formats_loading = true;
    expect(component.canSelectAudioLanguage()).toBe(false);
    expect(component.canSelectSubtitleLanguage()).toBe(false);
    component.cachedAvailableFormats[component.url].formats_loading = false;
    component.audioOnly = true;
    expect(component.canSelectSubtitleLanguage()).toBe(false);
    component.url = '';
    expect(component.canSelectAudioLanguage()).toBe(false);
  });

  it('remembers menu preferences and resets subtitle source when its language is cleared', () => {
    component.selectedQuality = '720';
    component.selectedSubtitleLanguage = 'en';
    component.selectedSubtitleSource = 'automatic';
    component.toggleAudioOnlyFromMenu();
    expect(component.audioOnly).toBe(true);
    expect(component.selectedQuality).toBe('');
    expect(component.selectedSubtitleLanguage).toBe('');
    expect(component.selectedSubtitleSource).toBe('');
    expect(localStorage.getItem('audioOnly')).toBe('true');
    component.onSelectedSubtitleLanguageChanged('en');
    expect(component.selectedSubtitleSource).toBe('manual');
    component.onSelectedSubtitleLanguageChanged(null);
    expect(component.selectedSubtitleSource).toBe('');
    for (const [method, key] of [
      ['autoplayChanged', 'autoplay'], ['customArgsEnabledChanged', 'customArgsEnabled'],
      ['replaceArgsChanged', 'replaceArgs'], ['customOutputEnabledChanged', 'customOutputEnabled'],
      ['youtubeAuthEnabledChanged', 'youtubeAuthEnabled']
    ]) {
      component[method]({ checked: true });
      expect(localStorage.getItem(key)).toBe('true');
    }
  });

  it('chooses audio by language preference, then bitrate, size and container compatibility', () => {
    const base = { format_id: 'base', vcodec: 'none', abr: 128, ext: 'webm', filesize: 100, language: 'fr', language_preference: 0 };
    const parsed: any = component.getAudioAndVideoFormats([
      base, { ...base, format_id: 'larger', filesize: 200 }, { ...base, format_id: 'compatible', filesize: 200, ext: 'm4a' },
      { ...base, format_id: 'other-language', language: 'en', language_preference: -1, abr: 320 },
      { ...base, format_id: 'higher-bitrate', abr: 192 }
    ]);
    expect(parsed.best_audio_format.format_id).toBe('higher-bitrate');
    expect(parsed.best_merge_audio_format.format_id).toBe('compatible');
    expect(parsed.audio_formats_by_key['128K'].default.format_id).toBe('compatible');
    expect(parsed.best_audio_formats_by_language.en.format_id).toBe('other-language');
  });

  it('retains a video-only source while preferring the matching muxed container', () => {
    const base = { format_id: 'video', vcodec: 'vp9', acodec: 'none', ext: 'webm', height: 720, fps: 30, filesize: 100 };
    const parsed: any = component.getAudioAndVideoFormats([
      base, { ...base, format_id: 'muxed-webm', acodec: 'opus', language: 'fr' },
      { ...base, format_id: 'muxed-mp4', acodec: 'aac', ext: 'mp4', language: 'fr' },
      { ...base, format_id: 'larger', acodec: 'aac', ext: 'mp4', language: 'fr', filesize: 200 }
    ]);
    expect(parsed.video[0].format_id).toBe('larger');
    expect(parsed.video[0].video_only_format_id).toBe('video');
    expect(parsed.best_muxed_formats_by_language.fr.format_id).toBe('larger');
  });
});
