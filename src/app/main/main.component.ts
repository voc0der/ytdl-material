import { Component, OnInit, ElementRef, ViewChild, ViewChildren, QueryList } from '@angular/core';
import {PostsService} from '../posts.services';
import { fromEvent, Subject } from 'rxjs';
import {UntypedFormControl, Validators} from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { saveAs } from 'file-saver';
import { YoutubeSearchService, Result } from '../youtube-search.service';
import { Router, ActivatedRoute } from '@angular/router';
import { Platform } from '@angular/cdk/platform';
import { ArgModifierDialogComponent } from 'app/dialogs/arg-modifier-dialog/arg-modifier-dialog.component';
import { ConfirmDialogComponent } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { MediaLibraryComponent } from 'app/components/media-library/media-library.component';
import { PLAYER_NAVIGATOR_STORAGE_KEY } from 'app/media-library-navigation-state.service';
import { DatabaseFile, Download, FileType, Playlist } from 'api-types';
import { debounceTime, filter, map, switchMap, take, takeUntil, tap } from 'rxjs/operators';

@Component({
    selector: 'app-root',
    templateUrl: './main.component.html',
    styleUrls: ['./main.component.css'],
    standalone: false
})
export class MainComponent implements OnInit {
  youtubeAuthDisabledOverride = false;

  iOS = false;

  // local settings
  determinateProgress = false;
  downloadingfile = false;
  audioOnly: boolean;
  autoplay = false;
  customArgsEnabled = false;
  customArgs = null;
  customOutputEnabled = false;
  replaceArgs = false;
  customOutput = null;
  youtubeAuthEnabled = false;
  youtubeUsername = null;
  youtubePassword = null;
  cropFile = false;
  cropFileStart = null;
  cropFileEnd = null;
  urlError = false;
  path: string | string[] = '';
  url = '';
  exists = '';
  autoStartDownload = false;

  // global settings
  fileManagerEnabled = false;
  allowQualitySelect = false;
  downloadOnlyMode = false;
  forceAutoplay = false;
  sponsorBlockDownloadsEnabled = false;
  globalCustomArgs = null;
  allowAdvancedDownload = false;
  useDefaultDownloadingAgent = true;
  customDownloadingAgent = null;

  // cache
  cachedAvailableFormats: { [key: string]: any } = Object.create(null);
  cachedFileManagerEnabled = localStorage.getItem('cached_filemanager_enabled') === 'true';

  // youtube api
  youtubeSearchEnabled = false;
  youtubeAPIKey = null;
  results_loading = false;
  results_showing = true;
  results = [];

  playlists = {'audio': [], 'video': []};
  playlist_thumbnails = {};
  downloads: Download[] = [];
  download_uids: string[] = [];
  current_download: Download = null;

  urlForm = new UntypedFormControl('', [Validators.required]);

  qualityOptions = {
    'video': [
      {
        'resolution': '3840x2160',
        'value': '2160',
        'label': '2160p (4K)'
      },
      {
        'resolution': '2560x1440',
        'value': '1440',
        'label': '1440p'
      },
      {
        'resolution': '1920x1080',
        'value': '1080',
        'label': '1080p'
      },
      {
        'resolution': '1280x720',
        'value': '720',
        'label': '720p'
      },
      {
        'resolution': '720x480',
        'value': '480',
        'label': '480p'
      },
      {
        'resolution': '480x360',
        'value': '360',
        'label': '360p'
      },
      {
        'resolution': '360x240',
        'value': '240',
        'label': '240p'
      },
      {
        'resolution': '256x144',
        'value': '144',
        'label': '144p'
      }
    ],
    'audio': [
      // TODO: implement
      // {
      //   'kbitrate': '256',
      //   'value': '256K',
      //   'label': '256 Kbps'
      // },
      // {
      //   'kbitrate': '160',
      //   'value': '160K',
      //   'label': '160 Kbps'
      // },
      // {
      //   'kbitrate': '128',
      //   'value': '128K',
      //   'label': '128 Kbps'
      // },
      // {
      //   'kbitrate': '96',
      //   'value': '96K',
      //   'label': '96 Kbps'
      // },
      // {
      //   'kbitrate': '70',
      //   'value': '70K',
      //   'label': '70 Kbps'
      // },
      // {
      //   'kbitrate': '50',
      //   'value': '50K',
      //   'label': '50 Kbps'
      // },
      // {
      //   'kbitrate': '32',
      //   'value': '32K',
      //   'label': '32 Kbps'
      // }
    ]
  }

  selectedMaxQuality = '';
  selectedQuality: string | unknown = '';
  selectedAudioLanguage = '';
  selectedSubtitleLanguage = '';
  selectedSubtitleSource = '';
  formats_loading = false;

  @ViewChild('urlinput', { read: ElementRef }) urlInput: ElementRef;
  @ViewChild('mediaLibrary') mediaLibrary: MediaLibraryComponent;
  last_valid_url = '';
  last_url_check = 0;

  argsChangedSubject: Subject<boolean> = new Subject<boolean>();
  private readonly destroy$ = new Subject<void>();
  simulatedOutput = '';

  interval_id = null;

  constructor(public postsService: PostsService, private youtubeSearch: YoutubeSearchService, public snackBar: MatSnackBar,
    private router: Router, public dialog: MatDialog, private platform: Platform, private route: ActivatedRoute) {
    this.audioOnly = false;
  }

  get showCreatePlaylistShortcut(): boolean {
    return !!this.mediaLibrary && this.mediaLibrary.showLibraryTabs && this.mediaLibrary.activeLibraryTab === 1;
  }

  openCreatePlaylistDialog(): void {
    this.mediaLibrary?.openCreatePlaylistDialog();
  }

  async configLoad(): Promise<void> {
    await this.loadConfig();
    if (this.autoStartDownload) {
      this.downloadClicked();
    }
  }

  async loadConfig(): Promise<boolean> {
    // loading config
    this.fileManagerEnabled = this.postsService.config['Extra']['file_manager_enabled']
                              && this.postsService.hasPermission('filemanager');
    this.downloadOnlyMode = this.postsService.config['Extra']['download_only_mode'];
    this.forceAutoplay = this.postsService.config['Extra']['force_autoplay'];
    this.globalCustomArgs = this.postsService.config['Downloader']['custom_args'];
    this.youtubeSearchEnabled = this.postsService.config['API'] && this.postsService.config['API']['use_youtube_API'] &&
        this.postsService.config['API']['youtube_API_key'];
    this.youtubeAPIKey = this.youtubeSearchEnabled ? this.postsService.config['API']['youtube_API_key'] : null;
    this.sponsorBlockDownloadsEnabled = !!(this.postsService.config['API'] && this.postsService.config['API']['use_sponsorblock_API']);
    this.allowQualitySelect = this.postsService.config['Extra']['allow_quality_select'];
    this.allowAdvancedDownload = this.postsService.config['Advanced']['allow_advanced_download']
                                  && this.postsService.hasPermission('advanced_download');
    this.useDefaultDownloadingAgent = this.postsService.config['Advanced']['use_default_downloading_agent'];
    this.customDownloadingAgent = this.postsService.config['Advanced']['custom_downloading_agent'];

    // set final cache items

    localStorage.setItem('cached_filemanager_enabled', this.fileManagerEnabled.toString());
    this.cachedFileManagerEnabled = this.fileManagerEnabled;

    if (this.allowAdvancedDownload) {
      if (localStorage.getItem('customArgsEnabled') !== null) {
        this.customArgsEnabled = localStorage.getItem('customArgsEnabled') === 'true';
      }

      if (localStorage.getItem('customOutputEnabled') !== null) {
        this.customOutputEnabled = localStorage.getItem('customOutputEnabled') === 'true';
      }

      if (localStorage.getItem('replaceArgs') !== null) {
        this.replaceArgs = localStorage.getItem('replaceArgs') === 'true';
      }

      if (localStorage.getItem('youtubeAuthEnabled') !== null) {
        this.youtubeAuthEnabled = localStorage.getItem('youtubeAuthEnabled') === 'true';
      }

      // set advanced inputs
      const customArgs = localStorage.getItem('customArgs');
      const customOutput = localStorage.getItem('customOutput');
      const youtubeUsername = localStorage.getItem('youtubeUsername');

      if (customArgs && customArgs !== 'null') { this.customArgs = customArgs }
      if (customOutput && customOutput !== 'null') { this.customOutput = customOutput }
      if (youtubeUsername && youtubeUsername !== 'null') { this.youtubeUsername = youtubeUsername }

      this.getSimulatedOutput();
    }

    // get downloads routine
    if (this.interval_id) { clearInterval(this.interval_id) }
    this.interval_id = setInterval(() => {
      if (this.current_download) {
        this.getCurrentDownload();
      }
    }, 1000);

    return true;
  }

  // app initialization.
  ngOnInit(): void {
    if (this.postsService.initialized) {
      this.configLoad();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1), takeUntil(this.destroy$))
        .subscribe(() => this.configLoad());
    }

    this.postsService.config_reloaded
      .pipe(takeUntil(this.destroy$))
      .subscribe(changed => {
        if (changed) {
          this.loadConfig();
        }
      });

    this.iOS = this.platform.IOS;

    // get checkboxes
    if (localStorage.getItem('audioOnly') !== null) {
      this.audioOnly = localStorage.getItem('audioOnly') === 'true';
    }

    this.autoplay = this.forceAutoplay;
    if (!this.forceAutoplay && localStorage.getItem('autoplay') !== null) {
      this.autoplay = localStorage.getItem('autoplay') === 'true';
    }

    // check if params exist
    if (this.route.snapshot.paramMap.get('url')) {
      this.url = decodeURIComponent(this.route.snapshot.paramMap.get('url'));
      this.audioOnly = this.route.snapshot.paramMap.get('audioOnly') === 'true';

      // set auto start flag to true
      this.autoStartDownload = true;
    }

    this.argsChangedSubject
      .pipe(debounceTime(500), takeUntil(this.destroy$))
      .subscribe((should_simulate) => {
        if (should_simulate) this.getSimulatedOutput();
    });
  }

  ngAfterViewInit(): void {
    if (this.youtubeSearchEnabled && this.youtubeAPIKey) {
      this.youtubeSearch.initializeAPI(this.youtubeAPIKey);
      this.attachToInput();
    }
  }

  ngOnDestroy(): void {
    if (this.interval_id) { clearInterval(this.interval_id) }
    this.destroy$.next();
    this.destroy$.complete();
  }

  // download helpers
  downloadHelper(container: DatabaseFile | Playlist, type: string, is_playlist = false, force_view = false, navigate_mode = false): void {
    this.downloadingfile = false;
    if (!this.autoplay && !this.downloadOnlyMode && !navigate_mode) {
      // do nothing
      this.reloadMediaLibrary(is_playlist);
    } else {
      // if download only mode, just download the file. no redirect
      if (force_view === false && this.downloadOnlyMode && !this.iOS) {
        if (is_playlist) {
          this.downloadPlaylist(container['uid']);
        } else {
          this.downloadFileFromServer(container as DatabaseFile, type);
        }
        this.reloadMediaLibrary(is_playlist);
      } else {
        this.reloadMediaLibrary(is_playlist);
        sessionStorage.setItem(PLAYER_NAVIGATOR_STORAGE_KEY, this.router.url.split(';')[0]);
        if (is_playlist) {
          this.router.navigate(['/player', {playlist_id: container['id'], type: type}]);
        } else {
          this.router.navigate(['/player', {type: type, uid: container['uid']}]);
        }
      }
    }
  }

  // secondary download menu actions beyond the always-available audio toggle
  hasAdditionalDownloadMenuActions(): boolean {
    return this.sponsorBlockDownloadsEnabled || this.hasPlaylistUrlInInput() || this.hasChannelSearchPlaylistUrlInInput();
  }

  hasPlaylistUrlInInput(): boolean {
    return this.getPlaylistDownloadUrl(this.url || '') !== null;
  }

  hasChannelSearchPlaylistUrlInInput(): boolean {
    return this.getYouTubeChannelSearchPlaylistRequest(this.url || '') !== null;
  }

  downloadPlaylistClicked(): void {
    const playlist_url = this.getPlaylistDownloadUrl(this.url || '');
    if (!playlist_url) {
      this.downloadClicked();
      return;
    }
    this.downloadClicked(false, playlist_url, false);
  }

  downloadChannelSearchPlaylistClicked(): void {
    const channel_search_request = this.getYouTubeChannelSearchPlaylistRequest(this.url || '');
    if (!channel_search_request) {
      this.downloadClicked();
      return;
    }
    this.downloadClicked(false, channel_search_request.url, false, true);
  }

  downloadClicked(disableSponsorBlock = false, urlOverride: string | null = null, sanitizeSingleWatchUrl = true, channelSearchPlaylist = false): void {
    let effective_url = typeof urlOverride === 'string' ? urlOverride : (this.url || '');

    // Sanitize single YouTube watch URLs (keep only v=...)
    const urls_for_sanitize = this.getURLArray(effective_url);
    if (sanitizeSingleWatchUrl && urls_for_sanitize.length === 1) {
      const sanitized = this.sanitizeYouTubeWatchUrl(urls_for_sanitize[0]);
      if (sanitized && sanitized !== urls_for_sanitize[0]) {
        effective_url = sanitized;
        if (urlOverride === null) {
          this.url = sanitized;
        }
      }
    }

    if (!this.ValidURL(effective_url)) {
      this.urlError = true;
      return;
    }

    this.urlError = false;

    // get common args
    const customArgs = (this.customArgsEnabled && this.replaceArgs ? this.customArgs : null);
    const additionalArgs = (this.customArgsEnabled && !this.replaceArgs ? this.customArgs : null);
    const customOutput = (this.customOutputEnabled ? this.customOutput : null);
    const youtubeUsername = (this.youtubeAuthEnabled && this.youtubeUsername ? this.youtubeUsername : null);
    const youtubePassword = (this.youtubeAuthEnabled && this.youtubePassword ? this.youtubePassword : null);

    // set advanced inputs
    if (this.allowAdvancedDownload) {
      if (customArgs) {
        localStorage.setItem('customArgs', customArgs);
      }
      if (customOutput) {
        localStorage.setItem('customOutput', customOutput);
      }
      if (youtubeUsername) {
        localStorage.setItem('youtubeUsername', youtubeUsername);
      }
    }

    const type = this.audioOnly ? 'audio' : 'video';

    const customQualityConfiguration = type === 'audio' ? this.getSelectedAudioFormat() : this.getSelectedVideoFormat();
    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    const selectedSubtitleLanguage = this.audioOnly ? null : this.getSelectedSubtitleLanguage();
    const selectedSubtitleType = this.audioOnly ? null : this.getSelectedSubtitleType();

    let cropFileSettings = null;

    if (this.cropFile) {
      cropFileSettings = {
        cropFileStart: this.cropFileStart,
        cropFileEnd: this.cropFileEnd
      }
    }

    const selected_quality = this.selectedQuality;
    const selected_audio_language = selectedAudioLanguage;
    const selected_subtitle_language = selectedSubtitleLanguage;
    const selected_subtitle_type = selectedSubtitleType;
    this.selectedQuality = '';
    this.selectedAudioLanguage = '';
    this.selectedSubtitleLanguage = '';
    this.selectedSubtitleSource = '';
    this.downloadingfile = true;

    const urls = this.getURLArray(effective_url);
    for (let i = 0; i < urls.length; i++) {
      const url = sanitizeSingleWatchUrl ? this.sanitizeYouTubeWatchUrl(urls[i]) : urls[i];
      this.postsService.downloadFile(url, type as FileType, (customQualityConfiguration || selected_quality === '' || typeof selected_quality !== 'string' ? null : selected_quality),
        customQualityConfiguration, customArgs, additionalArgs, customOutput, youtubeUsername, youtubePassword, cropFileSettings, disableSponsorBlock, channelSearchPlaylist, selected_audio_language, selected_subtitle_language, selected_subtitle_type).subscribe(res => {
          const queued_downloads = Array.isArray(res['downloads']) && res['downloads'].length > 0
            ? res['downloads']
            : (res['download'] ? [res['download']] : []);
          if (queued_downloads.length === 0) {
            this.downloadingfile = false;
            this.current_download = null;
            this.postsService.openSnackBar($localize`Download failed!`, 'OK.');
            return;
          }

          for (const queued_download of queued_downloads) {
            if (!queued_download || !queued_download.uid) continue;
            const existing_download = this.getDownloadByUID(queued_download.uid);
            if (existing_download) {
              Object.assign(existing_download, queued_download);
            } else {
              this.downloads.push(queued_download);
            }
            if (!this.download_uids.includes(queued_download.uid)) {
              this.download_uids.push(queued_download.uid);
            }
          }
          if (!this.current_download) this.setNextCurrentDownload();
      }, () => { // can't access server
        this.downloadingfile = false;
        this.current_download = null;
        this.postsService.openSnackBar($localize`Download failed!`, 'OK.');
      });

      if (!this.autoplay && urls.length === 1) {
          const download_queued_message = $localize`Download for ${url}:url: has been queued!`;
          this.postsService.openSnackBar(download_queued_message);
          this.url = '';
          this.downloadingfile = false;
      }
    }
  }

  getSelectedAudioFormat(): string {
    const cachedFormats = this.cachedAvailableFormats[this.url] && this.cachedAvailableFormats[this.url]['formats'];
    if (!cachedFormats) return null;

    if (typeof this.selectedQuality === 'string') {
      return this.getDefaultAudioFormatForSelection();
    }

    const selectedAudioFormat = this.getPreferredAudioFormatForSelection(this.selectedQuality);
    return selectedAudioFormat ? selectedAudioFormat['format_id'] : null;
  }

  getSelectedVideoFormat(): string {
    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    const cachedFormats = this.cachedAvailableFormats[this.url] && this.cachedAvailableFormats[this.url]['formats'];
    if (!cachedFormats) return null;

    if (typeof this.selectedQuality === 'string') {
      return this.getDefaultVideoFormatForSelection();
    }

    if (!this.selectedQuality) return null;

    const preferredVideoFormat = this.getPreferredVideoFormatForSelection(this.selectedQuality);
    if (selectedAudioLanguage && preferredVideoFormat?.['language'] === selectedAudioLanguage && preferredVideoFormat?.['acodec'] && preferredVideoFormat['acodec'] !== 'none') {
      return preferredVideoFormat['format_id'];
    }

    let selected_video_format = preferredVideoFormat?.['format_id'] || this.selectedQuality['format_id'];
    const mergeAudioFormat = this.getPreferredMergeAudioFormatForSelection();

    if (selectedAudioLanguage && mergeAudioFormat?.['format_id']) {
      selected_video_format = preferredVideoFormat?.['video_only_format_id'] || this.selectedQuality['video_only_format_id'] || selected_video_format;
      return `${selected_video_format}+${mergeAudioFormat['format_id']}`;
    }

    // add in audio format if necessary
    const audio_missing = !preferredVideoFormat?.['acodec'] || preferredVideoFormat['acodec'] === 'none';
    if (audio_missing && mergeAudioFormat?.['format_id']) selected_video_format += `+${mergeAudioFormat['format_id']}`;
    return selected_video_format;
  }

  private getDefaultAudioFormatForSelection(): string | null {
    const cachedFormats = this.getCurrentCachedFormats();
    if (!cachedFormats) return null;

    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    if (!selectedAudioLanguage) return null;

    const selectedAudioFormat = cachedFormats['best_audio_formats_by_language']?.[selectedAudioLanguage]
      || cachedFormats['best_muxed_formats_by_language']?.[selectedAudioLanguage];

    return selectedAudioFormat?.['format_id'] || null;
  }

  private getDefaultVideoFormatForSelection(): string | null {
    const cachedFormats = this.getCurrentCachedFormats();
    if (!cachedFormats) return null;

    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    if (!selectedAudioLanguage) return null;

    const preferredMuxedFormat = cachedFormats['best_muxed_formats_by_language']?.[selectedAudioLanguage];
    if (preferredMuxedFormat?.['format_id']) {
      return preferredMuxedFormat['format_id'];
    }

    const highestQualityVideo = Array.isArray(cachedFormats['video']) ? cachedFormats['video'][0] : null;
    const mergeAudioFormat = cachedFormats['best_merge_audio_formats_by_language']?.[selectedAudioLanguage];
    const videoFormatId = highestQualityVideo?.['video_only_format_id'] || highestQualityVideo?.['format_id'] || null;

    if (videoFormatId && mergeAudioFormat?.['format_id']) {
      return `${videoFormatId}+${mergeAudioFormat['format_id']}`;
    }

    return null;
  }

  getDownloadByUID(uid: string): Download {
    const index = this.downloads.findIndex(download => download.uid === uid);
    if (index !== -1) {
      return this.downloads[index];
    } else {
      return null;
    }
  }

  removeDownloadFromCurrentDownloads(download_to_remove: Download): boolean {
    if (!download_to_remove || !download_to_remove.uid) return false;
    if (this.current_download && this.current_download.uid === download_to_remove.uid) {
      this.current_download = null;
    }
    this.download_uids = this.download_uids.filter(uid => uid !== download_to_remove.uid);
    const index = this.downloads.findIndex(download => download.uid === download_to_remove.uid);
    if (index !== -1) {
      this.downloads.splice(index, 1);
      this.setNextCurrentDownload();
      return true;
    } else {
      this.setNextCurrentDownload();
      return false;
    }
  }

  downloadFileFromServer(file: DatabaseFile, type: string): void {
    const ext = type === 'audio' ? 'mp3' : 'mp4'
    this.postsService.downloadFileFromServer(file.uid).subscribe(res => {
      const blob: Blob = res;
      saveAs(blob, decodeURIComponent(file.id) + `.${ext}`);

      if (!this.fileManagerEnabled) {
        // tell server to delete the file once downloaded
        this.postsService.deleteFile(file.uid).subscribe(() => {});
      }
    });
  }

  downloadPlaylist(playlist: Playlist): void {
    this.postsService.downloadPlaylistFromServer(playlist.id).subscribe(res => {
      const blob: Blob = res;
      saveAs(blob, playlist.name + '.zip');
    });

  }

  clearInput(): void {
    this.url = '';
    this.selectedQuality = '';
    this.selectedAudioLanguage = '';
    this.selectedSubtitleLanguage = '';
    this.selectedSubtitleSource = '';
    this.results_showing = false;
  }

  onInputBlur(): void {
    this.results_showing = false;
  }

  visitURL(url: string): void {
    window.open(url);
  }

  useURL(url: string): void {
    this.results_showing = false;
    this.selectedQuality = '';
    this.selectedAudioLanguage = '';
    this.selectedSubtitleLanguage = '';
    this.selectedSubtitleSource = '';
    this.url = url;
    this.ValidURL(url);
  }

  inputChanged(new_val: string): void {
    this.selectedQuality = '';
    this.selectedAudioLanguage = '';
    this.selectedSubtitleLanguage = '';
    this.selectedSubtitleSource = '';
    if (new_val === '' || !new_val) {
      this.results_showing = false;
    } else {
      if (this.ValidURL(new_val)) {
        this.results_showing = false;
      }
    }
  }

  // checks if url is a valid URL
  ValidURL(str: string): boolean {
    // mark multiple urls as valid but don't get additional info
    const urls = this.getURLArray(str);
    if (urls.length > 1) {
      this.autoplay = false;
      return true;
    }
    
    // tslint:disable-next-line: max-line-length
    const strRegex = /((([A-Za-z]{3,9}:(?:\/\/)?)(?:[-;:&=\+\$,\w]+@)?[A-Za-z0-9.-]+|(?:www.|[-;:&=\+\$,\w]+@)[A-Za-z0-9.-]+)((?:\/[\+~%\/.\w-_]*)?\??(?:[-\+=&;%@.\w_]*)#?(?:[\w]*))?)/;
    const re = new RegExp(strRegex);
    const valid = re.test(str);

    if (!valid) { return false; }

    // tslint:disable-next-line: max-line-length
    const youtubeStrRegex = /(?:http(?:s)?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:(?:watch)?\?(?:.*&)?v(?:i)?=|(?:embed|v|vi|user)\/))([^\?&\"'<> #]+)/;
    const reYT = new RegExp(youtubeStrRegex);
    const ytValid = true;
    if (valid && ytValid && Date.now() - this.last_url_check > 1000) {
      if (str !== this.last_valid_url && this.allowQualitySelect) {
        // get info
        this.getURLInfo(str);
        this.argsChanged();
      }
      this.last_valid_url = str;
    }
    return valid;
  }

  getURLInfo(url: string): void {
    if (!this.cachedAvailableFormats[url]) {
      this.cachedAvailableFormats[url] = Object.create(null);
    }
    const probe_url = this.sanitizeSingleVideoProbeUrl(url);
    // If URL resolves to a playlist-like feed, skip per-file format probing.
    if (this.isYouTubePlaylistUrl(probe_url) || this.isYouTubeChannelSearchPlaylistUrl(probe_url)) {
      // make it think that formats errored so that users have options
      this.cachedAvailableFormats[url]['formats_loading'] = false;
      this.cachedAvailableFormats[url]['formats_failed'] = true;
      return;
    }
    if (!(this.cachedAvailableFormats[url] && this.cachedAvailableFormats[url]['formats'])) {
      this.cachedAvailableFormats[url]['formats_loading'] = true;
      this.postsService.getFileFormats(probe_url).subscribe(res => {
        this.cachedAvailableFormats[url]['formats_loading'] = false;
        const infos = res['result'];
        if (!infos || !infos.formats) {
          this.errorFormats(url);
          return;
        }
        this.cachedAvailableFormats[url]['formats'] = this.getAudioAndVideoFormats(infos.formats, infos);
      }, () => {
        this.errorFormats(url);
      });
    }
  }

  private safeParseURL(raw: string): URL | null {
    try {
      const hasScheme = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(raw);
      return new URL(hasScheme ? raw : `https://${raw}`);
    } catch {
      return null;
    }
  }

  private getPlaylistDownloadUrl(raw: string): string | null {
    const urls = this.getURLArray(raw || '');
    if (urls.length !== 1) return null;
    const playlist_id = this.getYouTubePlaylistId(urls[0]);
    if (!playlist_id) return null;
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist_id)}`;
  }

  private getYouTubeChannelSearchPlaylistRequest(raw: string): { url: string } | null {
    const urls = this.getURLArray(raw || '');
    if (urls.length !== 1) return null;

    const parsed_url = this.safeParseURL(urls[0]);
    if (!parsed_url) return null;

    const host = parsed_url.hostname.replace(/^www\./, '').toLowerCase();
    const is_youtube_host = host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com';
    if (!is_youtube_host) return null;

    const query = parsed_url.searchParams.get('query')?.trim();
    if (!query) return null;

    const path_segments = parsed_url.pathname.split('/').filter(Boolean);
    if (path_segments.length < 2 || path_segments[path_segments.length - 1] !== 'search') return null;

    const channel_segment = path_segments[path_segments.length - 2];
    const parent_segment = path_segments.length > 2 ? path_segments[path_segments.length - 3] : '';
    const is_channel_search_path = channel_segment.startsWith('@') || ['channel', 'c', 'user'].includes(parent_segment);
    if (!is_channel_search_path) return null;

    return { url: parsed_url.toString() };
  }

  private getYouTubePlaylistId(raw: string): string | null {
    const parsed_url = this.safeParseURL(raw);
    if (!parsed_url) return null;
    const host = parsed_url.hostname.replace(/^www\./, '').toLowerCase();
    const is_youtube_host = host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be';
    if (!is_youtube_host) return null;
    const playlist_id = parsed_url.searchParams.get('list');
    return playlist_id || null;
  }

  // If this is a YouTube watch URL (or youtu.be), return a canonical single-video URL with ONLY v=
  // Otherwise return the input unchanged.
  private sanitizeYouTubeWatchUrl(raw: string): string {
    const u = this.safeParseURL(raw);
    if (!u) return raw;

    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const isYouTubeHost = host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be';
    if (!isYouTubeHost) return raw;

    let videoId: string;

    if (host === 'youtu.be') {
      videoId = u.pathname.replace(/^\/+/, '').split('/')[0] || '';
    } else {
      videoId = u.searchParams.get('v') || '';

      // Support common alternate URL shapes
      if (!videoId && u.pathname.startsWith('/shorts/')) {
        const parts = u.pathname.split('/').filter(Boolean);
        videoId = parts[1] || '';
      }
      if (!videoId) {
        const parts = u.pathname.split('/').filter(Boolean);
        if ((parts[0] === 'embed' || parts[0] === 'v' || parts[0] === 'vi') && parts[1]) {
          videoId = parts[1];
        }
      }
    }

    if (!videoId) return raw;
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  private sanitizeSingleVideoProbeUrl(raw: string): string {
    const parsed_url = this.safeParseURL(raw);
    if (!parsed_url) return raw;

    if (parsed_url.searchParams.has('v')) {
      return this.sanitizeYouTubeWatchUrl(raw);
    }

    return raw;
  }

  // Detect actual playlist pages / pure playlist links.
  // NOTE: watch?v=...&list=... is treated as a single video (we sanitize it above).
  private isYouTubePlaylistUrl(raw: string): boolean {
    const u = this.safeParseURL(raw);
    if (!u) {
      return raw.includes('youtube.com/playlist') || raw.includes('/playlist?');
    }

    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const isYouTubeHost = host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com';
    if (!isYouTubeHost) return false;

    const sp = u.searchParams;

    // https://www.youtube.com/playlist?list=...
    if (u.pathname.startsWith('/playlist') && sp.has('list')) return true;

    // Any URL with list= but no v= is effectively a playlist request
    if (sp.has('list') && !sp.has('v')) return true;

    return false;
  }

  private isYouTubeChannelSearchPlaylistUrl(raw: string): boolean {
    return this.getYouTubeChannelSearchPlaylistRequest(raw) !== null;
  }


  getSimulatedOutput(): void {
    const urls = this.getURLArray(this.url);
    if (urls.length > 1) return;

    // this function should be very similar to downloadClicked()
    const customArgs = (this.customArgsEnabled && this.replaceArgs ? this.customArgs : null);
    const additionalArgs = (this.customArgsEnabled && !this.replaceArgs ? this.customArgs : null);
    const customOutput = (this.customOutputEnabled ? this.customOutput : null);
    const youtubeUsername = (this.youtubeAuthEnabled && this.youtubeUsername ? this.youtubeUsername : null);
    const youtubePassword = (this.youtubeAuthEnabled && this.youtubePassword ? this.youtubePassword : null);

    const type = this.audioOnly ? 'audio' : 'video';

    const customQualityConfiguration = type === 'audio' ? this.getSelectedAudioFormat() : this.getSelectedVideoFormat();
    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    const selectedSubtitleLanguage = this.audioOnly ? null : this.getSelectedSubtitleLanguage();
    const selectedSubtitleType = this.audioOnly ? null : this.getSelectedSubtitleType();

    let cropFileSettings = null;

    if (this.cropFile) {
      cropFileSettings = {
        cropFileStart: this.cropFileStart,
        cropFileEnd: this.cropFileEnd
      }
    }

    this.postsService.generateArgs(this.url, type as FileType, (customQualityConfiguration || this.selectedQuality === '' || typeof this.selectedQuality !== 'string' ? null : this.selectedQuality),
      customQualityConfiguration, customArgs, additionalArgs, customOutput, youtubeUsername, youtubePassword, cropFileSettings, false, selectedAudioLanguage, selectedSubtitleLanguage, selectedSubtitleType).subscribe(res => {
        const simulated_args = res['args'];
        if (simulated_args) {
          // hide password if needed
          const passwordIndex = simulated_args.indexOf('--password');
          if (passwordIndex !== -1 && passwordIndex !== simulated_args.length - 1) {
            simulated_args[passwordIndex + 1] = simulated_args[passwordIndex + 1].replace(/./g, '*');
          }
          const downloader = this.getEffectiveDownloaderForCurrentSelection(selectedAudioLanguage, selectedSubtitleLanguage);
          this.simulatedOutput = `${downloader} ${this.url} ${simulated_args.join(' ')}`;
        }
    });
  }

  errorFormats(url: string): void {
    this.cachedAvailableFormats[url]['formats_loading'] = false;
    this.cachedAvailableFormats[url]['formats_failed'] = true;
    console.error('Could not load formats for url ' + url);
  }

  attachToInput(): void {
    fromEvent(this.urlInput.nativeElement, 'keyup')
      .pipe(
        map((e: any) => e.target.value),            // extract the value of input
        filter((text: string) => text.length > 1),  // filter out if empty
        debounceTime(250),                          // only once every 250ms
        tap(() => this.results_loading = true),     // enable loading
        switchMap((query: string) => this.youtubeSearch.search(query)),
        takeUntil(this.destroy$)
      )
      .subscribe(
        (results: Result[]) => {
          this.results_loading = false;
          if (this.url !== '' && results && results.length > 0) {
            this.results = results;
            this.results_showing = true;
          } else {
            this.results_showing = false;
          }
        },
        (err: any) => {
          console.log(err)
          this.results_loading = false;
          this.results_showing = false;
        },
        () => { // on completion
          this.results_loading = false;
        }
      );
  }

  argsChanged(): void {
    this.argsChangedSubject.next(true);
  }

  private setAudioOnly(next_value: boolean): void {
    this.audioOnly = next_value;
    this.selectedQuality = '';
    this.selectedSubtitleLanguage = '';
    this.selectedSubtitleSource = '';
    localStorage.setItem('audioOnly', next_value.toString());
    this.argsChanged();
  }

  toggleAudioOnlyFromMenu(): void {
    this.setAudioOnly(!this.audioOnly);
  }

  toggleAutoplayFromMenu(): void {
    this.autoplay = !this.autoplay;
    localStorage.setItem('autoplay', this.autoplay.toString());
  }

  onSelectedSubtitleLanguageChanged(new_value: string): void {
    this.selectedSubtitleLanguage = typeof new_value === 'string' ? new_value : '';
    if (this.selectedSubtitleLanguage === '') {
      this.selectedSubtitleSource = '';
      this.argsChanged();
      return;
    }

    const selected_subtitle_option = this.getAvailableSubtitleLanguages()
      .find(option => option.value === this.selectedSubtitleLanguage);
    this.selectedSubtitleSource = selected_subtitle_option?.source || '';
    this.argsChanged();
  }

  autoplayChanged(new_val): void {
    localStorage.setItem('autoplay', new_val.checked.toString());
  }

  customArgsEnabledChanged(new_val): void {
    localStorage.setItem('customArgsEnabled', new_val.checked.toString());
    this.argsChanged();
  }

  replaceArgsChanged(new_val): void {
    localStorage.setItem('replaceArgs', new_val.checked.toString());
    this.argsChanged();
  }

  customOutputEnabledChanged(new_val): void {
    localStorage.setItem('customOutputEnabled', new_val.checked.toString());
    this.argsChanged();
  }

  youtubeAuthEnabledChanged(new_val): void {
    localStorage.setItem('youtubeAuthEnabled', new_val.checked.toString());
    this.argsChanged();
  }

  getAvailableAudioLanguages(): Array<{value: string, label: string}> {
    const cachedFormats = this.getCurrentCachedFormats();
    return cachedFormats?.['audio_languages'] || [];
  }

  getAvailableSubtitleLanguages(): Array<{value: string, label: string, source: string, hasManual: boolean, hasAutomatic: boolean}> {
    const cachedFormats = this.getCurrentCachedFormats();
    return cachedFormats?.['subtitle_languages'] || [];
  }

  canSelectAudioLanguage(): boolean {
    if (!this.url) return false;
    if (this.getCachedFormatsEntry(this.url)?.['formats_loading']) return false;
    return this.getAvailableAudioLanguages().length > 0;
  }

  canSelectSubtitleLanguage(): boolean {
    if (this.audioOnly || !this.url) return false;
    if (this.getCachedFormatsEntry(this.url)?.['formats_loading']) return false;
    return this.getAvailableSubtitleLanguages().length > 0;
  }

  private getSelectedAudioLanguage(): string | null {
    return typeof this.selectedAudioLanguage === 'string' && this.selectedAudioLanguage !== ''
      ? this.selectedAudioLanguage
      : null;
  }

  private getSelectedSubtitleLanguage(): string | null {
    return typeof this.selectedSubtitleLanguage === 'string' && this.selectedSubtitleLanguage !== ''
      ? this.selectedSubtitleLanguage
      : null;
  }

  private getSelectedSubtitleType(): string | null {
    const selectedSubtitleLanguage = this.getSelectedSubtitleLanguage();
    if (!selectedSubtitleLanguage) return null;
    if (this.selectedSubtitleSource === 'manual' || this.selectedSubtitleSource === 'automatic') {
      return this.selectedSubtitleSource;
    }
    const selectedSubtitleOption = this.getAvailableSubtitleLanguages()
      .find(option => option.value === selectedSubtitleLanguage);
    return selectedSubtitleOption?.source || null;
  }

  private getEffectiveDownloaderForCurrentSelection(selectedAudioLanguage: string | null = null, selectedSubtitleLanguage: string | null = null): string {
    return (selectedAudioLanguage || selectedSubtitleLanguage) ? 'yt-dlp' : (this.postsService.config?.Advanced?.default_downloader || 'yt-dlp');
  }

  private getCachedFormatsEntry(url: string): any {
    if (!url) return null;

    if (this.cachedAvailableFormats[url]) {
      return this.cachedAvailableFormats[url];
    }

    const sanitized_url = this.sanitizeSingleVideoProbeUrl(url);
    if (sanitized_url && sanitized_url !== url && this.cachedAvailableFormats[sanitized_url]) {
      return this.cachedAvailableFormats[sanitized_url];
    }

    if (!sanitized_url) return null;

    for (const [cached_url, cached_entry] of Object.entries(this.cachedAvailableFormats)) {
      if (!cached_entry) continue;
      if (this.sanitizeSingleVideoProbeUrl(cached_url) === sanitized_url) {
        return cached_entry;
      }
    }

    return null;
  }

  private getCurrentCachedFormats(): any {
    const cachedFormatsEntry = this.getCachedFormatsEntry(this.url);
    return cachedFormatsEntry && cachedFormatsEntry['formats']
      ? cachedFormatsEntry['formats']
      : null;
  }

  private getPreferredAudioFormatForSelection(selectedQuality: any): any {
    const cachedFormats = this.getCurrentCachedFormats();
    if (!cachedFormats || !selectedQuality) return null;

    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    const selectedKey = selectedQuality['key'];
    const audioFormatsByKey = cachedFormats['audio_formats_by_key'];
    const matchingFormats = selectedKey && audioFormatsByKey ? audioFormatsByKey[selectedKey] : null;

    if (matchingFormats) {
      if (selectedAudioLanguage && matchingFormats['by_language']?.[selectedAudioLanguage]) {
        return matchingFormats['by_language'][selectedAudioLanguage];
      }
      if (selectedAudioLanguage && cachedFormats['best_audio_formats_by_language']?.[selectedAudioLanguage]) {
        return cachedFormats['best_audio_formats_by_language'][selectedAudioLanguage];
      }
      if (selectedAudioLanguage && cachedFormats['best_muxed_formats_by_language']?.[selectedAudioLanguage]) {
        return cachedFormats['best_muxed_formats_by_language'][selectedAudioLanguage];
      }
      if (matchingFormats['default']) {
        return matchingFormats['default'];
      }
    }

    if (selectedAudioLanguage && cachedFormats['best_audio_formats_by_language']?.[selectedAudioLanguage]) {
      return cachedFormats['best_audio_formats_by_language'][selectedAudioLanguage];
    }

    if (selectedAudioLanguage && cachedFormats['best_muxed_formats_by_language']?.[selectedAudioLanguage]) {
      return cachedFormats['best_muxed_formats_by_language'][selectedAudioLanguage];
    }

    return cachedFormats['best_audio_format'] || null;
  }

  private getPreferredVideoFormatForSelection(selectedQuality: any): any {
    const cachedFormats = this.getCurrentCachedFormats();
    if (!cachedFormats || !selectedQuality) return null;

    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    const selectedKey = selectedQuality['key'];
    const videoFormatsByKey = cachedFormats['video_formats_by_key'];
    const matchingFormats = selectedKey && videoFormatsByKey ? videoFormatsByKey[selectedKey] : null;

    if (matchingFormats) {
      if (selectedAudioLanguage && matchingFormats['by_language']?.[selectedAudioLanguage]) {
        return matchingFormats['by_language'][selectedAudioLanguage];
      }
      if (matchingFormats['default']) {
        return matchingFormats['default'];
      }
    }

    return selectedQuality;
  }

  private getPreferredMergeAudioFormatForSelection(): any {
    const cachedFormats = this.getCurrentCachedFormats();
    if (!cachedFormats) return null;

    const selectedAudioLanguage = this.getSelectedAudioLanguage();
    if (selectedAudioLanguage && cachedFormats['best_merge_audio_formats_by_language']?.[selectedAudioLanguage]) {
      return cachedFormats['best_merge_audio_formats_by_language'][selectedAudioLanguage];
    }

    return cachedFormats['best_merge_audio_format'] || null;
  }

  getAudioAndVideoFormats(formats, info = null): void {
    const audio_formats: any = {};
    const audio_formats_by_key: any = {};
    const video_formats: any = {};
    const video_formats_by_key: any = {};
    const language_options: any = {};
    const best_audio_formats_by_language: any = {};
    const best_merge_audio_formats_by_language: any = {};
    const best_muxed_formats_by_language: any = {};
    let best_audio_format = null;
    let best_merge_audio_format = null;

    for (let i = 0; i < formats.length; i++) {
      const format_obj = {type: null};

      const format = formats[i];
      const format_type = (format.vcodec === 'none') ? 'audio' : 'video';
      const language = this.getNormalizedAudioLanguage(format);

      format_obj.type = format_type;
      if (format_obj.type === 'audio' && format.abr) {
        const key = format.abr.toString() + 'K';
        format_obj['key'] = key;
        format_obj['bitrate'] = format.abr;
        format_obj['format_id'] = format.format_id;
        format_obj['ext'] = format.ext;
        format_obj['label'] = key;
        format_obj['language'] = language;
        format_obj['language_preference'] = this.getAudioLanguagePreference(format);
        format_obj['expected_filesize'] = format.filesize ? format.filesize : (format.filesize_approx || null);

        if (language) {
          language_options[language] = {
            value: language,
            label: this.getAudioLanguageLabel(language)
          };
        }

        if (!audio_formats_by_key[key]) {
          audio_formats_by_key[key] = {
            default: null,
            by_language: {}
          };
        }

        if (!audio_formats[key]) {
          audio_formats[key] = {
            key: key,
            bitrate: format.abr,
            label: key
          };
        }

        if (this.shouldReplaceAudioFormat(audio_formats_by_key[key]['default'], format_obj)) {
          audio_formats_by_key[key]['default'] = format_obj;
        }

        if (language && this.shouldReplaceAudioFormat(audio_formats_by_key[key]['by_language'][language], format_obj)) {
          audio_formats_by_key[key]['by_language'][language] = format_obj;
        }

        if (this.shouldReplaceAudioFormat(best_audio_format, format_obj)) {
          best_audio_format = format_obj;
        }

        if (this.shouldReplaceAudioFormat(best_merge_audio_format, format_obj, true)) {
          best_merge_audio_format = format_obj;
        }

        if (language && this.shouldReplaceAudioFormat(best_audio_formats_by_language[language], format_obj)) {
          best_audio_formats_by_language[language] = format_obj;
        }

        if (language && this.shouldReplaceAudioFormat(best_merge_audio_formats_by_language[language], format_obj, true)) {
          best_merge_audio_formats_by_language[language] = format_obj;
        }
      } else if (format_obj.type === 'video') {
        // check if video format is mp4
        const key = `${format.height}p${Math.round(format.fps)}`;
        if (format.ext === 'mp4' || format.ext === 'mkv' || format.ext === 'webm') {
          format_obj['key'] = key;
          format_obj['height'] = format.height;
          format_obj['acodec'] = format.acodec;
          format_obj['format_id'] = format.format_id;
          format_obj['label'] = key;
          format_obj['fps'] = Math.round(format.fps);
          format_obj['expected_filesize'] = format.filesize ? format.filesize : (format.filesize_approx || null);
          format_obj['ext'] = format.ext;
          format_obj['language'] = language;

          if (format.acodec === 'none') {
            format_obj['video_only_format_id'] = format.format_id;
          }

          if (language) {
            language_options[language] = {
              value: language,
              label: this.getAudioLanguageLabel(language)
            };
          }

          if (!video_formats_by_key[key]) {
            video_formats_by_key[key] = {
              default: null,
              by_language: {}
            };
          }

          const existingVideoOnlyFormatId = video_formats[key]?.['video_only_format_id'] || null;
          const existingVideoOnlyFormatIdByKey = video_formats_by_key[key]['default']?.['video_only_format_id'] || null;

          if (this.shouldReplaceVideoFormat(video_formats[key], format_obj)) {
            video_formats[key] = format_obj;
          }

          if (existingVideoOnlyFormatId && !video_formats[key]?.['video_only_format_id']) {
            video_formats[key]['video_only_format_id'] = existingVideoOnlyFormatId;
          }

          if (format.acodec === 'none' && !video_formats[key]?.['video_only_format_id']) {
            video_formats[key]['video_only_format_id'] = format.format_id;
          }

          if (this.shouldReplaceVideoFormat(video_formats_by_key[key]['default'], format_obj)) {
            video_formats_by_key[key]['default'] = format_obj;
          }

          if (existingVideoOnlyFormatIdByKey && !video_formats_by_key[key]['default']?.['video_only_format_id']) {
            video_formats_by_key[key]['default']['video_only_format_id'] = existingVideoOnlyFormatIdByKey;
          }

          if (format.acodec === 'none' && !video_formats_by_key[key]['default']?.['video_only_format_id']) {
            video_formats_by_key[key]['default']['video_only_format_id'] = format.format_id;
          }

          if (language && this.shouldReplaceVideoFormat(video_formats_by_key[key]['by_language'][language], format_obj)) {
            video_formats_by_key[key]['by_language'][language] = format_obj;
            if (existingVideoOnlyFormatIdByKey && !video_formats_by_key[key]['by_language'][language]?.['video_only_format_id']) {
              video_formats_by_key[key]['by_language'][language]['video_only_format_id'] = existingVideoOnlyFormatIdByKey;
            }
          }

          if (language && format.acodec !== 'none' && this.shouldReplaceVideoFormat(best_muxed_formats_by_language[language], format_obj)) {
            best_muxed_formats_by_language[language] = format_obj;
          }
        }
      }
    }

    const parsed_formats: any = {};

    parsed_formats['best_audio_format'] = best_audio_format;
    parsed_formats['best_audio_formats_by_language'] = best_audio_formats_by_language;
    parsed_formats['best_merge_audio_format'] = best_merge_audio_format || best_audio_format;
    parsed_formats['best_merge_audio_formats_by_language'] = best_merge_audio_formats_by_language;
    parsed_formats['best_muxed_formats_by_language'] = best_muxed_formats_by_language;
    parsed_formats['audio_formats_by_key'] = audio_formats_by_key;
    parsed_formats['video_formats_by_key'] = video_formats_by_key;
    parsed_formats['audio_languages'] = Object.values(language_options)
      .sort((a: any, b: any) => a.label.localeCompare(b.label));
    parsed_formats['subtitle_languages'] = this.getSubtitleLanguageOptions(info);

    // add audio file size to the expected video file size -- but only if best_audio_format will be used (i.e. when the video has no acodec already). if acodec is present expected filesize will include it
    for (const video_format of Object.values(video_formats)) {
      if ((!video_format['acodec'] || video_format['acodec'] === 'none')
        && video_format['expected_filesize']
        && parsed_formats['best_merge_audio_format']?.expected_filesize) 
          video_format['expected_filesize'] += parsed_formats['best_merge_audio_format'].expected_filesize;
    }

    parsed_formats['video'] = Object.values(video_formats);
    parsed_formats['audio'] = Object.values(audio_formats);

    parsed_formats['video'] = parsed_formats['video'].sort((a, b) => b.height - a.height || b.fps - a.fps);
    parsed_formats['audio'] = parsed_formats['audio'].sort((a, b) => b.bitrate - a.bitrate);

    return parsed_formats;
  }

  private shouldReplaceAudioFormat(currentFormat: any, candidateFormat: any, preferMp4Compatible = false): boolean {
    if (!candidateFormat) return false;
    if (!currentFormat) return true;

    const currentLanguagePreference = currentFormat['language_preference'] ?? Number.NEGATIVE_INFINITY;
    const candidateLanguagePreference = candidateFormat['language_preference'] ?? Number.NEGATIVE_INFINITY;
    if (candidateLanguagePreference !== currentLanguagePreference) {
      return candidateLanguagePreference > currentLanguagePreference;
    }

    if (preferMp4Compatible && candidateFormat['ext'] !== currentFormat['ext']) {
      if (candidateFormat['ext'] === 'm4a') return true;
      if (currentFormat['ext'] === 'm4a') return false;
    }

    if (candidateFormat['bitrate'] !== currentFormat['bitrate']) {
      return candidateFormat['bitrate'] > currentFormat['bitrate'];
    }

    const currentFilesize = currentFormat['expected_filesize'] || 0;
    const candidateFilesize = candidateFormat['expected_filesize'] || 0;
    if (candidateFilesize !== currentFilesize) {
      return candidateFilesize > currentFilesize;
    }

    if (candidateFormat['ext'] !== currentFormat['ext']) {
      if (candidateFormat['ext'] === 'm4a') return true;
      if (currentFormat['ext'] === 'm4a') return false;
    }

    return false;
  }

  private shouldReplaceVideoFormat(currentFormat: any, candidateFormat: any): boolean {
    if (!candidateFormat) return false;
    if (!currentFormat) return true;

    const currentHasAudio = !!currentFormat['acodec'] && currentFormat['acodec'] !== 'none';
    const candidateHasAudio = !!candidateFormat['acodec'] && candidateFormat['acodec'] !== 'none';
    if (candidateHasAudio !== currentHasAudio) {
      return candidateHasAudio;
    }

    const currentHeight = currentFormat['height'] || 0;
    const candidateHeight = candidateFormat['height'] || 0;
    if (candidateHeight !== currentHeight) {
      return candidateHeight > currentHeight;
    }

    const currentFps = currentFormat['fps'] || 0;
    const candidateFps = candidateFormat['fps'] || 0;
    if (candidateFps !== currentFps) {
      return candidateFps > currentFps;
    }

    const currentFilesize = currentFormat['expected_filesize'] || 0;
    const candidateFilesize = candidateFormat['expected_filesize'] || 0;
    if (candidateFilesize !== currentFilesize) {
      return candidateFilesize > currentFilesize;
    }

    if (candidateFormat['ext'] !== currentFormat['ext']) {
      if (candidateFormat['ext'] === 'mp4') return true;
      if (currentFormat['ext'] === 'mp4') return false;
    }

    return false;
  }

  private getNormalizedAudioLanguage(format: any): string | null {
    if (!format || typeof format['language'] !== 'string') return null;
    const language = format['language'].trim();
    if (language === '' || language.toLowerCase() === 'none') return null;
    return language;
  }

  private getAudioLanguagePreference(format: any): number {
    const languagePreference = Number(format?.['language_preference']);
    return Number.isFinite(languagePreference) ? languagePreference : Number.NEGATIVE_INFINITY;
  }

  private getAudioLanguageLabel(language: string): string {
    return this.getLanguageLabel(language);
  }

  private getSubtitleLanguageOptions(info: any): Array<{value: string, label: string, source: string, hasManual: boolean, hasAutomatic: boolean}> {
    const subtitle_options = Object.create(null);
    const automatic_label_suffix = $localize`:Automatic subtitle label:auto`;
    const addSubtitleOptions = (tracks: any, source: 'manual' | 'automatic') => {
      if (!tracks || typeof tracks !== 'object') return;

      for (const [language, entries] of Object.entries(tracks)) {
        const normalized_language = this.getNormalizedSubtitleLanguage(language, entries, source);
        if (!normalized_language) continue;

        if (!subtitle_options[normalized_language]) {
          subtitle_options[normalized_language] = {
            value: normalized_language,
            hasManual: false,
            hasAutomatic: false
          };
        }

        if (source === 'manual') {
          subtitle_options[normalized_language].hasManual = true;
        } else {
          subtitle_options[normalized_language].hasAutomatic = true;
        }
      }
    };

    addSubtitleOptions(info?.subtitles, 'manual');
    addSubtitleOptions(info?.automatic_captions, 'automatic');

    return Object.values(subtitle_options)
      .map((option: any) => ({
        ...option,
        source: option.hasManual ? 'manual' : 'automatic',
        label: option.hasManual
          ? this.getLanguageLabel(option.value)
          : `${this.getLanguageLabel(option.value)} (${automatic_label_suffix})`
      }))
      .sort((a: any, b: any) => a.label.localeCompare(b.label));
  }

  private getNormalizedSubtitleLanguage(language: string, entries: any, source: 'manual' | 'automatic' = 'manual'): string | null {
    if (typeof language !== 'string') return null;
    if (!Array.isArray(entries) || entries.length === 0) return null;

    const resolved_language = source === 'automatic'
      ? this.getAutomaticSubtitleSourceLanguage(entries, language)
      : language;
    const normalized_language = typeof resolved_language === 'string' ? resolved_language.trim() : '';
    if (normalized_language === '' || normalized_language.toLowerCase() === 'live_chat') return null;

    return normalized_language;
  }

  private getAutomaticSubtitleSourceLanguage(entries: any[], fallbackLanguage: string): string | null {
    let saw_translated_entry = false;

    for (const entry of entries) {
      const parsed_url = this.safeParseURL(entry?.url);
      if (!parsed_url) continue;

      const translated_language = parsed_url.searchParams.get('tlang');
      if (translated_language) {
        saw_translated_entry = true;
        continue;
      }

      const source_language = parsed_url.searchParams.get('lang');
      if (source_language && source_language.trim() !== '') {
        return source_language;
      }
    }

    return saw_translated_entry ? null : fallbackLanguage;
  }

  private getLanguageLabel(language: string): string {
    try {
      const locale = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
      const languageName = new Intl.DisplayNames([locale], {type: 'language'}).of(language);
      return languageName || language;
    } catch {
      return language;
    }
  }

  // modify custom args
  openArgsModifierDialog(): void {
    const dialogRef = this.dialog.open(ArgModifierDialogComponent, {
      data: {
       initial_args: this.customArgs
      }
    });
    dialogRef.afterClosed().subscribe(new_args => {
      if (new_args !== null && new_args !== undefined) {
        this.customArgs = new_args;
      }
    });
  }

  getCurrentDownload(): void {
    if (!this.current_download) {
      return;
    }
    this.postsService.getCurrentDownload(this.current_download['uid']).subscribe(res => {
      if (res['download']) {
        this.current_download = res['download'];

        if (this.current_download['finished'] && !this.current_download['error']) {
          const completed_download = this.current_download;
          const container = completed_download['container'];
          const file_uids = Array.isArray(completed_download['file_uids']) ? completed_download['file_uids'] : [];
          const is_playlist = file_uids.length > 1;
          const type = completed_download['type'];
          const completed_uid = completed_download.uid;
          const duplicate_skip_only = !!completed_download['duplicate_skip_only'];
          this.finishTrackedDownload(completed_uid);

          if (duplicate_skip_only) {
            this.reloadMediaLibrary(is_playlist);
            if (!is_playlist) {
              this.openDuplicateSkippedDialog(completed_download);
              return;
            }
          }

          if (container && type) {
            this.downloadHelper(container, type, is_playlist, false);
          } else if (!this.current_download) {
            this.reloadMediaLibrary(is_playlist);
          }
        } else if (this.current_download['finished'] && this.current_download['error']) {
          const failed_download_uid = this.current_download.uid;
          this.finishTrackedDownload(failed_download_uid);
          this.postsService.openSnackBar($localize`Download failed!`, 'OK.');
        }
      } else {
        // console.log('failed to get new download');
      }
    });
  }

  private finishTrackedDownload(download_uid: string): void {
    this.downloadingfile = false;
    this.current_download = null;
    this.downloads = this.downloads.filter(download => download && download.uid !== download_uid);
    this.download_uids = this.download_uids.filter(uid => uid !== download_uid);
    this.setNextCurrentDownload();
  }

  private openDuplicateSkippedDialog(download: Download): void {
    const duplicate_title = download && download['title'] ? download['title'] : (download && download.url ? download.url : $localize`This video`);
    this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogTitle: $localize`Duplicate skipped`,
        dialogText: $localize`${duplicate_title}:download title: was already downloaded, so the duplicate was skipped.`,
        submitText: $localize`OK`,
        cancelText: $localize`Close`
      }
    });
  }

  private setNextCurrentDownload(): void {
    if (this.current_download) return;
    if (!Array.isArray(this.download_uids) || this.download_uids.length === 0) return;

    for (const download_uid of this.download_uids) {
      if (!download_uid) continue;
      const queued_download = this.getDownloadByUID(download_uid);
      if (queued_download) {
        this.current_download = queued_download;
        return;
      }
      this.current_download = {uid: download_uid} as Download;
      return;
    }
  }

  reloadMediaLibrary(is_playlist = false): void {
    this.postsService.files_changed.next(true);
    if (is_playlist) this.postsService.playlists_changed.next(true);
  }

  getURLArray(url_str: string): Array<string> {
    let lines = url_str.split('\n');
    lines = lines.filter(line => line);
    return lines;
  }

    /**
   * Format bytes as human-readable text.
   * From: https://stackoverflow.com/questions/10420352/converting-file-size-in-bytes-to-human-readable-string
   * 
   * @param bytes Number of bytes.
   * @param si True to use metric (SI) units, aka powers of 1000. False to use 
   *           binary (IEC), aka powers of 1024.
   * @param dp Number of decimal places to display.
   * 
   * @return Formatted string.
   */
  humanFileSize(bytes: number, si=true, dp=1) {
    const thresh = si ? 1000 : 1024;

    if (Math.abs(bytes) < thresh) {
      return bytes + ' B';
    }

    const units = si 
      ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] 
      : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    let u = -1;
    const r = 10**dp;

    do {
      bytes /= thresh;
      ++u;
    } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);


    return bytes.toFixed(dp) + ' ' + units[u];
  }
}
