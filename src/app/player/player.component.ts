import { Component, OnInit, HostListener, OnDestroy, AfterViewInit, AfterViewChecked, ViewChild, ChangeDetectorRef, ElementRef, ChangeDetectionStrategy } from '@angular/core';
import {
  addEvaIcons, EvaActiveChapter, EvaApi, EvaBuffering, EvaChapterList, EvaChapterMarker, EvaControlsContainer, EvaControlsDivider,
  EvaErrorOverlay, EvaFullscreen, EvaKeyboardShortcutsConfiguration, EvaMute, EvaOverlayPlay, EvaPictureInPicture, EvaPlaybackSpeed,
  EvaPlayer, EvaPlayPause, EvaScrubBar, EvaScrubBarBufferingTime, EvaScrubBarCurrentTime, EvaSubtitleDisplay, EvaTimeDisplay,
  EvaTimeFormating, EvaTooltip, EvaTrack, EvaTrackSelector, EvaUserInteractionEventsDirective, EvaVideoSource, EvaVolume
} from 'ez-vid-ang';
import {
  evaFullscreenExitIcon, evaFullscreenIcon, evaPauseIcon, evaPictureInPictureIcon, evaPlayIcon, evaVolumeHighIcon, evaVolumeLowIcon,
  evaVolumeMediumIcon, evaVolumeMuteIcon
} from 'ez-vid-ang/icons';
import { PostsService } from 'app/posts.services';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { CdkDragDrop, moveItemInArray, CdkDropList, CdkDrag } from '@angular/cdk/drag-drop';
import { ShareMediaDialogComponent } from '../dialogs/share-media-dialog/share-media-dialog.component';
import { DatabaseFile, FileType, FileTypeFilter, Playlist, Sort } from '../../api-types';
import { TwitchChatComponent } from 'app/components/twitch-chat/twitch-chat.component';
import { VideoInfoDialogComponent } from 'app/dialogs/video-info-dialog/video-info-dialog.component';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { saveBlob } from '../utils/save-blob';
import { fileThumbnailURL, formatDuration } from '../utils/file-display';
import { filesize } from 'filesize';
import { Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { NgClass } from '@angular/common';
import { MatDrawerContainer, MatDrawer } from '@angular/material/sidenav';
import { MatIcon } from '@angular/material/icon';
import { MatSlider, MatSliderRangeThumb } from '@angular/material/slider';
import { MatProgressBar } from '@angular/material/progress-bar';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { SeeMoreComponent } from '../components/see-more/see-more.component';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { ConcurrentStreamComponent } from '../components/concurrent-stream/concurrent-stream.component';
import { TwitchChatComponent as TwitchChatComponent_1 } from '../components/twitch-chat/twitch-chat.component';


export interface IMedia {
  title: string;
  src: string;
  type: string;
  label: string;
  url: string;
  uid?: string;
  chapters?: IChapter[];
  subtitles?: ISubtitleTrack[];
  // What the list under the player shows beside the title.
  thumbnail?: string | null;
  duration?: string;
  uploader?: string;
}

export interface ISubtitleTrack {
  label: string;
  language: string;
  kind?: string;
  default?: boolean;
  src?: string;
}

export interface IChapter {
  title: string;
  start_time: number;
  end_time: number;
}

addEvaIcons({
  evaFullscreenExitIcon, evaFullscreenIcon, evaPauseIcon, evaPictureInPictureIcon, evaPlayIcon, evaVolumeHighIcon, evaVolumeLowIcon,
  evaVolumeMediumIcon, evaVolumeMuteIcon
});

const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Holding the left button, or a finger, on the picture plays at SPEED_HOLD_RATE until it is let
// go. A press released sooner is an ordinary click.
const SPEED_HOLD_DELAY_MS = 400;
const SPEED_HOLD_RATE = 2;
// A press that drifts further than this before the hold engages is a drag, not a hold.
const SPEED_HOLD_MOVE_TOLERANCE_PX = 10;

interface SpeedHold {
  src: string;
  start_x: number;
  start_y: number;
  // Pending until the hold engages; null once it has.
  timer: ReturnType<typeof setTimeout> | null;
  previous_rate: number;
  was_paused: boolean;
}

// No key is bound unless it is listed here. 0-9 (jump to a tenth of the way through) and ?
// (list the shortcuts) are always on.
const KEYBOARD_SHORTCUTS: EvaKeyboardShortcutsConfiguration = {
  playPause: 'Space',
  backwardsKeyOne: 'J',
  forwardKeyOne: 'L',
  backwardsKeyTwo: 'ArrowLeft',
  forwardKeyTwo: 'ArrowRight',
  muteKey: 'M',
  fullscreen: 'F',
  nextSubtitleTrackKey: 'C',
  increasePlaybackSpeedKey: '>',
  decreasePlaybackSpeedKey: '<'
};

// The player's shortcuts ignore Ctrl, Alt and Cmd, so without stopping them first Ctrl+C would
// switch subtitles instead of copying and Ctrl+F would go full screen instead of finding.
const PLAYER_SHORTCUT_KEYS = new Set([
  ...Object.values(KEYBOARD_SHORTCUTS).filter((key): key is string => typeof key === 'string').map(key => key.toUpperCase()),
  ...'0123456789?'
]);

function keepModifiedKeysFromPlayer(event: KeyboardEvent): void {
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
  if (!PLAYER_SHORTCUT_KEYS.has(event.key.toUpperCase())) return;
  if ((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  event.stopPropagation();
}

const AUTOPLAY_STORAGE_KEY = 'player_autoplay_enabled';
const REPEAT_STORAGE_KEY = 'player_repeat_enabled';

// Mirrors files_api.MIN_SNIP_DURATION_SECONDS. A shorter selection is almost always a
// mis-drag, and ffmpeg can emit a zero-frame file for a sub-frame range.
const MIN_SNIP_DURATION_SECONDS = 1;
const SNIP_STATUS_POLL_INTERVAL_MS = 1000;
const SNIP_SEEK_DEBOUNCE_MS = 80;
const THEATER_TOOLBAR_HIDE_DELAY_MS = 2000;
// A row of the list under the player is dragged at once with a mouse, but only after a press
// and hold on a touch screen. Otherwise every swipe that starts on a row drags it, and the
// list cannot be scrolled.
const QUEUE_TOUCH_DRAG_DELAY_MS = 400;

@Component({
    selector: 'app-player',
    templateUrl: './player.component.html',
    styleUrls: ['./player.component.css'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [NgClass, MatDrawerContainer, EvaPlayer, EvaOverlayPlay, EvaBuffering, EvaErrorOverlay, EvaSubtitleDisplay, EvaScrubBar,
      EvaScrubBarBufferingTime, EvaScrubBarCurrentTime, EvaChapterList, EvaControlsContainer, EvaUserInteractionEventsDirective, EvaPlayPause,
      EvaMute, EvaVolume, EvaTimeDisplay, EvaActiveChapter, EvaControlsDivider, EvaTrackSelector, EvaPlaybackSpeed, EvaPictureInPicture,
      EvaFullscreen, EvaTooltip, MatIcon, MatSlider, MatSliderRangeThumb, MatProgressBar, MatButton, MatTooltip, SeeMoreComponent, MatIconButton, MatProgressSpinner, CdkDropList, CdkDrag, ConcurrentStreamComponent, MatDrawer, TwitchChatComponent_1]
})
export class PlayerComponent implements OnInit, AfterViewInit, AfterViewChecked, OnDestroy {

  playlist: Array<IMedia> = [];
  original_playlist: string = null;
  playlist_updating = false;

  show_player = false;

  currentIndex = 0;
  currentItem: IMedia = null;
  // The <video> the player renders, once it is ready.
  media: HTMLVideoElement | null = null;
  evaApi: EvaApi | null = null;
  private eva_player: EvaPlayer | null = null;
  private media_listeners: Array<() => void> = [];
  private player_ready_subscription: Subscription | null = null;

  // params
  uids: string[];
  type: FileType;
  playlist_id = null; // used for playlists (not subscription)
  file_objs: DatabaseFile[] = []; // used for playlists
  uid = null; // used for non-subscription files (audio, video, playlist)
  subscription = null;
  sub_id = null;
  subPlaylist = null;
  uuid = null; // used for sharing in multi-user mode, uuid is the user that downloaded the video
  // The owner of a shared library this is played from, which is only ever watched, never changed.
  library: string = null;
  timestamp = null;
  auto = null;
  queue_sort_by = 'registered';
  queue_sort_order = -1;
  queue_file_type_filter: FileTypeFilter = null;
  queue_favorite_filter = false;
  queue_category_filter_uids: string[] = [];
  queue_search = null;
  queue_sub_id = null;

  db_playlist: Playlist = null;
  db_file: DatabaseFile = null;
  currentFile: DatabaseFile = null;

  baseStreamPath = null;
  audioFolderPath = null;
  videoFolderPath = null;
  subscriptionFolderPath = null;

  // url-mode params
  url = null;
  name = null;

  downloading = false;
  playlistDownloadSubscription: Subscription | null = null;

  autoplay_enabled = false;
  repeat_enabled = false;
  theater_mode_enabled = false;
  theater_toolbar_visible = false;
  theater_toolbar_hide_timer: ReturnType<typeof setTimeout> | null = null;
  autoplay_queue_loading = false;
  autoplay_queue_initialized = false;
  pending_autoplay_advance = false;
  autoplay_queue_file_objs: DatabaseFile[] = [];
  playbackTime = 0;

  readonly dragStartDelay = {touch: QUEUE_TOUCH_DRAG_DELAY_MS, mouse: 0};
  // Thumbnails that failed to load, such as a shared playlist's for somebody not logged in.
  // Their rows show an icon instead of a broken image.
  failed_thumbnails = new Set<string>();
  private revealed_queue_row: string | null = null;

  // snip mode
  snip_mode = false;
  snip_start = 0;
  snip_end = 0;
  snip_in_progress = false;
  snip_percent = 0;
  snip_poll_timer: ReturnType<typeof setTimeout> | null = null;
  snip_seek_timer: ReturnType<typeof setTimeout> | null = null;

  currentChapters: IChapter[] = [];
  chapterDropdownOpen = false;
  currentChapterLabel = $localize`Chapters`;
  activeChapterIndex = -1;
  chapterCacheByUID = new Map<string, IChapter[]>();
  subtitleCacheByUID = new Map<string, ISubtitleTrack[]>();
  chapterLoadInFlight = new Set<string>();
  currentSubtitleTracks: ISubtitleTrack[] = [];
  private destroyed = false;

  readonly speed_hold_rate = SPEED_HOLD_RATE;
  speed_hold_active = false;
  private speed_hold: SpeedHold | null = null;

  readonly keyboard_shortcuts = KEYBOARD_SHORTCUTS;
  readonly playback_speeds = PLAYBACK_SPEEDS;
  time_format: EvaTimeFormating = 'mm:ss';
  chapter_list_open = false;
  // The player takes its sources, tracks and chapters by reference, and reloads or re-reads
  // them whenever that changes, so each is rebuilt only when what it comes from does.
  private video_sources: EvaVideoSource[] = [];
  private video_sources_for: IMedia | null = null;
  private video_tracks: EvaTrack[] = [];
  private video_tracks_for: ISubtitleTrack[] | null = null;
  private chapter_markers: EvaChapterMarker[] = [];
  private chapter_markers_for: IChapter[] | null = null;

  readonly nextTooltip = $localize`Next (Shift+N)`;
  readonly theaterTooltip = $localize`Theater mode (t)`;
  readonly subtitlesText = $localize`Subtitles`;
  readonly subtitlesOffText = $localize`Off`;
  readonly chaptersText = $localize`Chapters`;
  readonly playbackErrorText = $localize`This file can't be played.`;
  readonly retryText = $localize`Retry`;

  @ViewChild('twitchchat') twitchChat: TwitchChatComponent;
  @ViewChild(EvaPlayer) set evaPlayer(player: EvaPlayer | undefined) {
    const api = player?.playerMainAPI ?? null;
    if (api === this.evaApi) return;
    this.eva_player = player ?? null;
    this.evaApi = api;
    this.player_ready_subscription?.unsubscribe();
    this.player_ready_subscription = null;
    if (!api) return;
    if (api.isPlayerReady) {
      // Not during the change detection that found the player.
      queueMicrotask(() => this.onPlayerReady(api.assignedVideoElement));
    } else {
      this.player_ready_subscription = api.playerReadyEvent.subscribe(() => this.onPlayerReady(api.assignedVideoElement));
    }
  }
  @ViewChild('queueList') queueList?: ElementRef<HTMLElement>;

  ngOnInit(): void {
    window.addEventListener('keydown', keepModifiedKeysFromPlayer, true);
    this.initPlaybackModeToggles();
    this.playlist_id = this.route.snapshot.paramMap.get('playlist_id');
    this.uid = this.route.snapshot.paramMap.get('uid');
    this.sub_id = this.route.snapshot.paramMap.get('sub_id');
    this.url = this.route.snapshot.paramMap.get('url');
    this.name = this.route.snapshot.paramMap.get('name');
    this.uuid = this.route.snapshot.paramMap.get('uuid');
    this.library = this.route.snapshot.paramMap.get('library');
    this.timestamp = this.route.snapshot.paramMap.get('timestamp');
    this.auto = this.route.snapshot.paramMap.get('auto');
    this.queue_sort_by = this.route.snapshot.paramMap.get('queue_sort_by') ?? 'registered';
    this.queue_sort_order = this.parseSortOrder(this.route.snapshot.paramMap.get('queue_sort_order'));
    this.queue_file_type_filter = this.parseFileTypeFilter(this.route.snapshot.paramMap.get('queue_file_type_filter'));
    this.queue_favorite_filter = this.route.snapshot.paramMap.get('queue_favorite_filter') === 'true';
    this.queue_category_filter_uids = this.parseCategoryFilterUids(this.route.snapshot.paramMap.get('queue_category_filter_uids'));
    this.queue_search = this.route.snapshot.paramMap.get('queue_search');
    this.queue_sub_id = this.route.snapshot.paramMap.get('queue_sub_id');

    // loading config
    if (this.postsService.initialized) {
      this.processConfig();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => this.processConfig());
    }
  }

  ngAfterViewInit(): void {
    this.cdr.detectChanges();
    // On hard refresh, AppComponent may not have assigned the shared sidenav yet.
    setTimeout(() => this.postsService.sidenav?.close());
  }

  ngAfterViewChecked(): void {
    const row = this.currentItem ? `${this.currentIndex}/${this.playlist.length}/${this.theater_mode_enabled}` : null;
    if (row === this.revealed_queue_row) return;
    this.revealed_queue_row = row;
    this.revealCurrentQueueRow();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.removeEventListener('keydown', keepModifiedKeysFromPlayer, true);
    this.setTheaterMode(false);
    this.playlistDownloadSubscription?.unsubscribe();
    this.playlistDownloadSubscription = null;
    this.clearTheaterToolbarHideTimer();
    this.clearSnipPoll();
    this.player_ready_subscription?.unsubscribe();
    this.player_ready_subscription = null;
    this.endSpeedHold();
    this.unloadMediaElement();
    this.detachMediaListeners();
    this.postsService.setPageTitle();
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.chapterDropdownOpen = false;
  }

  @HostListener('document:keydown.escape')
  exitTheaterMode(): void {
    if (this.theater_mode_enabled) this.setTheaterMode(false);
  }

  // The player's own shortcuts cover playback; these two are about the page around it.
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !this.media || this.isAudio()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cdk-overlay-container')) return;

    const key = event.key.toLowerCase();
    if (key === 't' && !event.shiftKey && this.canToggleTheaterMode() && !document.fullscreenElement) {
      this.toggleTheaterMode();
    } else if (key === 'n' && event.shiftKey && this.currentIndex + 1 < this.playlist.length) {
      this.advanceToNextVideo();
    } else {
      return;
    }
    event.preventDefault();
  }

  constructor(public postsService: PostsService, private route: ActivatedRoute, private dialog: MatDialog, private router: Router,
              private cdr: ChangeDetectorRef) {

  }

  processConfig(): void {
    this.baseStreamPath = this.postsService.path;
    this.audioFolderPath = this.postsService.config['Downloader']['path-audio'];
    this.videoFolderPath = this.postsService.config['Downloader']['path-video'];
    this.subscriptionFolderPath = this.postsService.config['Subscriptions']['subscriptions_base_path'];
    this.postsService.setPageTitle();

    if (this.sub_id) {
      this.getSubscription();
    } else if (this.playlist_id) {
      this.getPlaylistFiles();
    } else if (this.uid) {
      this.getFile();
    } 

    if (this.url) {
      // if a url is given, just stream the URL
      this.playlist = [];
      const imedia: IMedia = {
        title: this.name,
        label: this.name,
        src: this.url,
        type: 'video/mp4',
        url: this.url,
        uid: this.uid
      }
      this.playlist.push(imedia);
      this.updateCurrentItem(this.playlist[0], 0);
      this.show_player = true;
    }
  }

  getFile(): void {
    this.postsService.getFile(this.uid, this.uuid, this.library).subscribe(res => {
      this.db_file = res['file'];
      if (!this.db_file) {
        this.postsService.openSnackBar($localize`Failed to get file information from the server.`, 'Dismiss');
        return;
      }
      // playlist_id is sent so a file played through a shared playlist can be counted:
      // the server accepts membership of a shared playlist as the capability, and the
      // file itself is often not shared on its own. A view of someone else's library is
      // not counted: the count is theirs, and nothing in their library is changed.
      if (!this.library) {
        this.postsService.incrementViewCount(this.db_file['uid'], null, this.uuid, this.playlist_id).subscribe(() => undefined, err => {
          console.error('Failed to increment view count');
          console.error(err);
        });
      }
      // regular video/audio file (not playlist)
      this.uids = [this.db_file['uid']];
      this.type = this.db_file['isAudio'] ? 'audio' as FileType : 'video' as FileType;
      this.parseFileNames();
    }, err => {
      console.error(err);
      this.postsService.openSnackBar($localize`Failed to get file information from the server.`, 'Dismiss');
    });
  }

  getSubscription(): void {
    this.postsService.getSubscription(this.sub_id).subscribe(res => {
      const subscription = res['subscription'];
      this.subscription = subscription;
      this.type = this.subscription.type;
      this.uids = this.subscription.videos.map(video => video['uid']);
      this.parseFileNames();
    }, () => {
      // TODO: Make translatable
      this.postsService.openSnackBar(`Failed to find subscription ${this.sub_id}`, 'Dismiss');
    });
  }

  getPlaylistFiles(): void {
    this.postsService.getPlaylist(this.playlist_id, this.uuid, true, this.library).subscribe(res => {
      if (res['playlist']) {
        this.db_playlist = res['playlist'];
        this.file_objs = res['file_objs'];
        this.uids = this.db_playlist.uids;
        this.type = res['type'];
        this.parseFileNames();
      } else {
        this.postsService.openSnackBar($localize`Failed to load playlist!`);
      }
    }, () => {
      this.postsService.openSnackBar($localize`Failed to load playlist!`);
    });
  }

  parseFileNames(): void {
    this.playlist = [];
    this.autoplay_queue_initialized = false;
    if (!this.queue_file_type_filter && this.db_file) {
      this.queue_file_type_filter = this.db_file.isAudio ? FileTypeFilter.AUDIO_ONLY : FileTypeFilter.VIDEO_ONLY;
    }
    for (let i = 0; i < this.uids.length; i++) {
      const file_obj = this.playlist_id ? this.file_objs[i]
                     : this.sub_id ? this.subscription['videos'][i]
                     : this.db_file;
      if (!file_obj) {
        continue;
      }

      const mediaObject: IMedia = this.createMediaObject(file_obj);
      this.playlist.push(mediaObject);
    }
    if (this.playlist.length === 0) {
      this.currentItem = null;
      this.currentFile = null;
      this.show_player = false;
      this.postsService.openSnackBar($localize`Failed to load playable items for this playlist.`);
      return;
    }
    if (this.db_playlist && this.db_playlist['randomize_order']) {
      this.shuffleArray(this.playlist);
    }
    const currentUID = this.currentItem?.uid;
    const currentIndex = currentUID ? this.playlist.findIndex(file_obj => file_obj.uid === currentUID) : this.currentIndex;
    this.currentIndex = currentIndex >= 0 && currentIndex < this.playlist.length ? currentIndex : 0;
    this.updateCurrentItem(this.playlist[this.currentIndex], this.currentIndex);
    this.original_playlist = JSON.stringify(this.playlist);
    this.show_player = true;

    if (this.autoplay_enabled) {
      this.ensureAutoplayQueueReady();
    }
  }

  onPlayerReady(media: HTMLVideoElement | null): void {
    if (this.destroyed || !media || media === this.media) return;
    this.detachMediaListeners();
    this.media = media;
    const listen = (target: EventTarget, event: string, handler: (event: Event) => void) => {
      target.addEventListener(event, handler);
      this.media_listeners.push(() => target.removeEventListener(event, handler));
    };
    listen(media, 'loadedmetadata', () => this.onMediaMetadataLoaded());
    listen(media, 'ended', () => this.nextVideo());
    listen(media, 'timeupdate', () => this.onPlaybackTimeUpdate());

    // The player draws subtitles itself from hidden tracks. One the browser shows draws twice,
    // and one it leaves off never loads, so the c shortcut could not switch to it.
    const hide = (track: TextTrack | null) => {
      if (track && track.mode !== 'hidden') track.mode = 'hidden';
    };
    const text_tracks = media.textTracks;
    if (typeof text_tracks?.addEventListener === 'function') {
      Array.from(text_tracks).forEach(hide);
      listen(text_tracks, 'addtrack', event => hide((event as TrackEvent).track as TextTrack));
    }

    if (this.timestamp) {
      media.currentTime = +this.timestamp;
    }
  }

  onMediaMetadataLoaded(): void {
    const duration = this.media?.duration;
    this.time_format = Number.isFinite(duration) && duration >= 3600 ? 'HH:mm:ss' : 'mm:ss';
  }

  private detachMediaListeners(): void {
    this.media_listeners.forEach(remove => remove());
    this.media_listeners = [];
  }

  nextVideo(): void {
      // Repeat loops the video, so it only ends when repeat is off.
      if (!this.autoplay_enabled) {
        return;
      }

      if (this.advanceToNextVideo()) {
        return;
      }

      if (this.shouldAutoloadWholeLibraryQueue()) {
        this.pending_autoplay_advance = true;
        this.ensureAutoplayQueueReady();
      }
  }

  updateCurrentItem(newCurrentItem: IMedia, newCurrentIndex: number) {
    this.currentItem  = newCurrentItem;
    this.currentIndex = newCurrentIndex;
    this.playbackTime = 0;
    this.chapter_list_open = false;
    this.syncCurrentSingleFileMetadata();
    this.syncCurrentFileMetadata();
    this.syncCurrentChapters();
    this.syncCurrentSubtitles();
    this.updatePageTitleForCurrentItem();
  }

  updatePageTitleForCurrentItem(): void {
    const media_title = this.currentItem?.title ? this.currentItem.title : null;
    this.postsService.setPageTitle(media_title);
  }

  isAudio(): boolean {
    return this.currentItem?.type === 'audio/mp3';
  }

  getVideoSources(): EvaVideoSource[] {
    if (this.video_sources_for !== this.currentItem) {
      this.video_sources_for = this.currentItem;
      // The source type is checked against what the browser can play, which knows mp3 as audio/mpeg.
      this.video_sources = this.currentItem
        ? [{src: this.currentItem.src, type: this.isAudio() ? 'audio/mpeg' : this.currentItem.type}]
        : [];
    }
    return this.video_sources;
  }

  getVideoTracks(): EvaTrack[] {
    if (this.video_tracks_for !== this.currentSubtitleTracks) {
      this.video_tracks_for = this.currentSubtitleTracks;
      this.video_tracks = this.currentSubtitleTracks
        .filter(subtitle => !!subtitle.src)
        .map(subtitle => ({
          kind: 'subtitles',
          srclang: subtitle.language,
          label: subtitle.label,
          src: subtitle.src,
          default: subtitle.default === true
        }));
    }
    return this.video_tracks;
  }

  getChapterMarkers(): EvaChapterMarker[] {
    if (this.chapter_markers_for !== this.currentChapters) {
      this.chapter_markers_for = this.currentChapters;
      this.chapter_markers = this.currentChapters.map(chapter => ({
        startTime: chapter.start_time,
        endTime: chapter.end_time,
        title: chapter.title
      }));
    }
    return this.chapter_markers;
  }

  onClickPlaylistItem(item: IMedia, index: number): void {
    if (item === this.currentItem) return;
    this.updateCurrentItem(item, index);
  }

  // The list under the player: the playlist or subscription being played, the library once
  // Autoplay has queued it, or the one file.
  queueTitle(): string {
    if (this.db_playlist?.name) return this.db_playlist.name;
    if (this.subscription?.name) return this.subscription.name;
    if (this.isSingleFileMode() && this.autoplay_queue_initialized) return $localize`:Player queue title for the library:Library`;
    return $localize`:Player queue title for a single file:Now playing`;
  }

  queueMeta(): string {
    if (this.autoplay_queue_loading) return $localize`Loading your library…`;
    if (this.playlist.length > 1) return $localize`:Player queue position:${this.currentIndex + 1}:position: of ${this.playlist.length}:count:`;
    if (this.isSingleFileMode() && !this.autoplay_enabled) return $localize`Turn on Autoplay to keep playing from your library.`;
    return '';
  }

  // Scrolls the list, and only the list, until the playing row is in it. The page stays where
  // it is, because the video is what is being watched when the next one starts.
  revealCurrentQueueRow(): void {
    const list = this.queueList?.nativeElement;
    const row = list?.querySelector<HTMLElement>('.playlist-row.current');
    if (!list || !row || list.scrollHeight <= list.clientHeight) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - 8);
    }
  }

  toggleAutoplayFromPlaylistRow(event: MouseEvent): void {
    event.stopPropagation();
    this.toggleAutoplay();
  }

  toggleAutoplay(): void {
    this.autoplay_enabled = !this.autoplay_enabled;
    if (this.autoplay_enabled) {
      this.repeat_enabled = false;
      this.saveRepeatMode();
      this.ensureAutoplayQueueReady();
    } else {
      this.pending_autoplay_advance = false;
      this.autoplay_queue_loading = false;
      this.collapseAutoplayQueueToCurrentItem();
    }
    this.saveAutoplayMode();
  }

  toggleRepeat(): void {
    this.repeat_enabled = !this.repeat_enabled;
    if (this.repeat_enabled) {
      this.autoplay_enabled = false;
      this.saveAutoplayMode();
      this.pending_autoplay_advance = false;
      this.autoplay_queue_loading = false;
      this.collapseAutoplayQueueToCurrentItem();
    }
    this.saveRepeatMode();
  }

  canToggleTheaterMode(): boolean {
    return this.currentItem?.type !== 'audio/mp3';
  }

  toggleTheaterMode(): void {
    if (!this.canToggleTheaterMode()) return;
    this.setTheaterMode(!this.theater_mode_enabled);
  }

  private setTheaterMode(enabled: boolean): void {
    this.theater_mode_enabled = enabled;
    this.theater_toolbar_visible = false;
    this.clearTheaterToolbarHideTimer();
    if (enabled && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    document.body.classList.toggle('player-theater-mode-active', enabled);
  }

  onTheaterToolbarMouseEnter(): void {
    if (!this.theater_mode_enabled) return;
    this.theater_toolbar_visible = true;
    this.clearTheaterToolbarHideTimer();
  }

  onTheaterToolbarMouseLeave(): void {
    this.scheduleTheaterToolbarHide();
  }

  private revealTheaterToolbar(): void {
    if (!this.theater_mode_enabled) return;
    this.theater_toolbar_visible = true;
    this.scheduleTheaterToolbarHide();
  }

  private scheduleTheaterToolbarHide(): void {
    if (!this.theater_mode_enabled) return;
    this.clearTheaterToolbarHideTimer();
    this.theater_toolbar_hide_timer = setTimeout(() => {
      this.theater_toolbar_visible = false;
      this.theater_toolbar_hide_timer = null;
    }, THEATER_TOOLBAR_HIDE_DELAY_MS);
  }

  private clearTheaterToolbarHideTimer(): void {
    if (!this.theater_toolbar_hide_timer) return;
    clearTimeout(this.theater_toolbar_hide_timer);
    this.theater_toolbar_hide_timer = null;
  }

  getFileNames(): string[] {
    const fileNames = [];
    for (let i = 0; i < this.playlist.length; i++) {
      fileNames.push(this.playlist[i].title);
    }
    return fileNames;
  }

  decodeURI(uri: string): string {
    return decodeURI(uri);
  }

  downloadContent(): void {
    if (this.downloading) return;

    const file_count = this.db_playlist?.uids?.length ?? this.file_objs.length;
    const total_size = this.file_objs.reduce((size, file) => size + (Number(file?.size) || 0), 0);
    const playlist_summary = total_size > 0
      ? $localize`${file_count}:playlist file count: files, ${filesize(total_size)}:playlist size:`
      : $localize`${file_count}:playlist file count: files`;
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Download playlist?`,
      dialogText: $localize`Download the entire playlist as a zip (${playlist_summary})? Creating the archive can take a while and use significant disk space.`,
      submitText: $localize`Download`
    });

    dialogRef.afterClosed().pipe(take(1)).subscribe(confirmed => {
      if (confirmed) this.startPlaylistDownload();
    });
  }

  startPlaylistDownload(): void {
    const zipName = this.db_playlist.name;
    this.downloading = true;
    this.playlistDownloadSubscription = this.postsService.downloadPlaylistFromServer(this.playlist_id, this.uuid).subscribe(res => {
      this.downloading = false;
      this.playlistDownloadSubscription = null;
      const blob: Blob = res;
      saveBlob(blob, zipName + '.zip');
    }, err => {
      console.error(err);
      this.downloading = false;
      this.playlistDownloadSubscription = null;
    });
  }

  cancelPlaylistDownload(): void {
    if (!this.downloading) return;

    this.playlistDownloadSubscription?.unsubscribe();
    this.playlistDownloadSubscription = null;
    this.downloading = false;
    this.postsService.openSnackBar($localize`Playlist download cancelled.`);
  }

  downloadFile(): void {
    const filename = this.currentItem?.title ?? this.playlist[0]?.title;
    const ext = (this.currentItem?.type === 'audio/mp3') ? '.mp3' : '.mp4';
    const uid = this.currentItem?.uid ?? this.uid;
    this.downloading = true;
    this.postsService.downloadFileFromServer(uid, this.uuid).subscribe(res => {
      this.downloading = false;
      const blob: Blob = res;
      saveBlob(blob, filename + ext);
    }, err => {
      console.error(err);
      this.downloading = false;
    });
  }

  playlistPostCreationHandler(playlistID: string): void {
    // changes the route without moving from the current view or
    // triggering a navigation event
    this.playlist_id = playlistID;
    this.router.navigateByUrl(this.router.url + ';id=' + playlistID);
  }

  drop(event: CdkDragDrop<string[]>): void {
    moveItemInArray(this.playlist, event.previousIndex, event.currentIndex);
    this.currentIndex = this.playlist.indexOf(this.currentItem);
  }

   playlistChanged(): boolean {
    return JSON.stringify(this.playlist) !== this.original_playlist;
  }

  openShareDialog(): void {
    const dialogRef = this.dialog.open(ShareMediaDialogComponent, {
      data: {
        uid: this.playlist_id ? this.playlist_id : this.uid,
        sharing_enabled: this.playlist_id ? this.db_playlist.sharingEnabled : this.db_file.sharingEnabled,
        is_playlist: !!this.playlist_id,
        uuid: this.postsService.isLoggedIn ? this.postsService.user.uid : this.uuid,
        current_timestamp: (this.media?.currentTime ?? 0) * 1000
      },
      panelClass: 'kit-dialog-panel',
      width: '520px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });

    dialogRef.afterClosed().subscribe(() => {
      if (!this.playlist_id) {
        this.getFile();
      } else {
        this.getPlaylistFiles();
      }
    });
  }
  
  openFileInfoDialog(): void {
    let file_obj = this.db_file;
    const original_uid = this.currentItem.uid;
    if (this.db_playlist) {
      const idx = this.getPlaylistFileIndexUID(original_uid);
      file_obj = this.file_objs[idx];
    }
    const dialogRef = this.dialog.open(VideoInfoDialogComponent, {
      data: {
        file: file_obj,
        allow_snip: this.canSnipCurrentFile(),
        library: this.library
      },
      panelClass: 'kit-dialog-panel',
      width: '720px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });

    dialogRef.afterClosed().subscribe(() => {
      if (this.db_file) this.db_file = dialogRef.componentInstance.file;
      else if (this.db_playlist) {
        const idx = this.getPlaylistFileIndexUID(original_uid);
        this.file_objs[idx] = dialogRef.componentInstance.file;
      }
      if (this.db_file) {
        this.patchAutoplayQueueFile(dialogRef.componentInstance.file);
      }
      this.syncCurrentFileMetadata();
      if (dialogRef.componentInstance.snip_requested) this.enterSnipMode();
    });
  }

  canSnipCurrentFile(): boolean {
    // A snip needs a real registered file to trim and a duration to lay the track out over.
    return !!this.currentFile?.uid && this.getSnipDuration() > MIN_SNIP_DURATION_SECONDS
      && this.postsService.hasPermission('filemanager') && !this.library;
  }

  getSnipDuration(): number {
    const media_duration = Number(this.media?.duration);
    if (Number.isFinite(media_duration) && media_duration > 0) return media_duration;
    const file_duration = Number(this.currentFile?.duration ?? this.db_file?.duration ?? 0);
    return Number.isFinite(file_duration) && file_duration > 0 ? file_duration : 0;
  }

  enterSnipMode(): void {
    if (!this.canSnipCurrentFile()) return;
    const duration = this.getSnipDuration();
    // Seed the selection around where they were watching rather than the whole file, since
    // the point of snipping is usually the moment they just saw.
    const current_time = Math.min(Math.max(this.playbackTime, 0), Math.max(duration - MIN_SNIP_DURATION_SECONDS, 0));
    this.snip_start = current_time;
    this.snip_end = Math.min(duration, Math.max(current_time + 30, current_time + MIN_SNIP_DURATION_SECONDS));
    this.snip_mode = true;
    this.snip_percent = 0;
    this.media?.pause();
    this.cdr.detectChanges();
  }

  exitSnipMode(): void {
    this.snip_mode = false;
    this.snip_in_progress = false;
    this.snip_percent = 0;
    this.clearSnipPoll();
    this.cdr.detectChanges();
  }

  clearSnipPoll(): void {
    if (this.snip_poll_timer) {
      clearTimeout(this.snip_poll_timer);
      this.snip_poll_timer = null;
    }
    if (this.snip_seek_timer) {
      clearTimeout(this.snip_seek_timer);
      this.snip_seek_timer = null;
    }
  }

  /**
   * Keep the knobs from crossing. The slider enforces this while dragging, but the
   * handlers below also run for programmatic changes, so clamp here as the single source
   * of truth.
   */
  onSnipStartChange(value: number): void {
    const duration = this.getSnipDuration();
    const clamped = Math.min(Math.max(Number(value) || 0, 0), Math.max(duration - MIN_SNIP_DURATION_SECONDS, 0));
    this.snip_start = clamped;
    if (this.snip_end - this.snip_start < MIN_SNIP_DURATION_SECONDS) {
      this.snip_end = Math.min(duration, this.snip_start + MIN_SNIP_DURATION_SECONDS);
    }
    this.seekWithinSnip(this.snip_start);
  }

  onSnipEndChange(value: number): void {
    const duration = this.getSnipDuration();
    const clamped = Math.min(Math.max(Number(value) || 0, MIN_SNIP_DURATION_SECONDS), duration);
    this.snip_end = clamped;
    if (this.snip_end - this.snip_start < MIN_SNIP_DURATION_SECONDS) {
      this.snip_start = Math.max(0, this.snip_end - MIN_SNIP_DURATION_SECONDS);
    }
    this.seekWithinSnip(this.snip_end);
  }

  seekWithinSnip(time: number): void {
    // Scrubbing a knob should preview that edge, which is the whole reason to pick the
    // range against the video rather than in a number field. valueChange fires on every
    // pixel of a drag, so coalesce them: seeking a large file on each event makes
    // scrubbing stutter.
    if (!this.media || this.snip_in_progress) return;
    this.playbackTime = time;
    if (this.snip_seek_timer) clearTimeout(this.snip_seek_timer);
    this.snip_seek_timer = setTimeout(() => {
      this.snip_seek_timer = null;
      if (this.destroyed || !this.media) return;
      this.media.currentTime = time;
    }, SNIP_SEEK_DEBOUNCE_MS);
  }

  getSnipSelectionLength(): number {
    return Math.max(0, this.snip_end - this.snip_start);
  }

  snipSelectionValid(): boolean {
    return this.getSnipSelectionLength() >= MIN_SNIP_DURATION_SECONDS;
  }

  // An arrow property rather than a method: mat-slider's displayWith calls this detached
  // from the component, so a prototype method would lose `this`.
  formatSnipTimestamp = (seconds: number): string => this.formatChapterTimestamp(seconds);

  previewSnip(): void {
    if (!this.media || !this.snipSelectionValid()) return;
    this.media.currentTime = this.snip_start;
    this.playMedia();
  }

  confirmSnip(): void {
    if (!this.snipSelectionValid() || this.snip_in_progress) return;
    const file_uid = this.currentFile?.uid;
    if (!file_uid) return;

    this.snip_in_progress = true;
    this.snip_percent = 0;
    this.media?.pause();

    this.postsService.snipFile(file_uid, this.snip_start, this.snip_end).subscribe(res => {
      if (!res?.success || !res.job_uid) {
        this.failSnip(res?.error);
        return;
      }
      this.pollSnipStatus(res.job_uid);
    }, err => {
      console.error(err);
      this.failSnip();
    });
  }

  pollSnipStatus(job_uid: string): void {
    this.clearSnipPoll();
    this.postsService.getSnipStatus(job_uid).subscribe(res => {
      if (this.destroyed) return;
      if (!res?.success) {
        this.failSnip(res?.error);
        return;
      }

      this.snip_percent = Math.round(Number(res.percent) || 0);

      if (res.status === 'complete') {
        this.snip_in_progress = false;
        this.snip_mode = false;
        this.clearSnipPoll();
        this.postsService.openSnackBar($localize`Snip created successfully.`);
        this.cdr.detectChanges();
        return;
      }
      if (res.status === 'failed') {
        this.failSnip(res.error);
        return;
      }

      this.cdr.detectChanges();
      this.snip_poll_timer = setTimeout(() => this.pollSnipStatus(job_uid), SNIP_STATUS_POLL_INTERVAL_MS);
    }, err => {
      console.error(err);
      this.failSnip();
    });
  }

  failSnip(error: string = null): void {
    this.snip_in_progress = false;
    this.snip_percent = 0;
    this.clearSnipPoll();
    this.postsService.openSnackBar(error || $localize`Failed to snip video.`);
    this.cdr.detectChanges();
  }

  getPlaylistFileIndexUID(uid: string): number {
    return this.file_objs.findIndex(file_obj => file_obj['uid'] === uid);
  }

  setPlaybackTimestamp(time: number): void {
    if (this.media) this.media.currentTime = time;
    this.playbackTime = time;
    this.refreshCurrentChapterState(time);
  }

  togglePlayback(to_play: boolean): void {
    if (to_play) {
      this.playMedia();
    } else {
      this.media?.pause();
    }
  }

  // A play the browser refuses, such as one it will not start without a click, is not an error.
  playMedia(): void {
    this.media?.play()?.catch(() => undefined);
  }

  setPlaybackRate(speed: number): void {
    if (this.media) this.media.playbackRate = speed;
  }

  initPlaybackModeToggles(): void {
    this.autoplay_enabled = localStorage.getItem(AUTOPLAY_STORAGE_KEY) === 'true';
    this.repeat_enabled = localStorage.getItem(REPEAT_STORAGE_KEY) === 'true';
    if (this.autoplay_enabled && this.repeat_enabled) {
      this.repeat_enabled = false;
      this.saveRepeatMode();
    }
  }

  saveAutoplayMode(): void {
    localStorage.setItem(AUTOPLAY_STORAGE_KEY, `${this.autoplay_enabled}`);
  }

  saveRepeatMode(): void {
    localStorage.setItem(REPEAT_STORAGE_KEY, `${this.repeat_enabled}`);
  }

  parseSortOrder(sortOrder: string): number {
    return sortOrder === '1' ? 1 : -1;
  }

  parseFileTypeFilter(fileTypeFilter: string): FileTypeFilter {
    if (fileTypeFilter === FileTypeFilter.AUDIO_ONLY || fileTypeFilter === FileTypeFilter.VIDEO_ONLY || fileTypeFilter === FileTypeFilter.BOTH) {
      return fileTypeFilter;
    }
    return null;
  }

  createMediaObject(file_obj: DatabaseFile): IMedia {
    const mime_type = file_obj.isAudio ? 'audio/mp3' : 'video/mp4';
    const hasChapterPayload = Array.isArray(file_obj.chapters);
    const normalizedChapters = hasChapterPayload ? this.normalizeChapters(file_obj.chapters) : undefined;
    const hasSubtitlePayload = Array.isArray(file_obj.subtitles);
    const normalizedSubtitles = hasSubtitlePayload ? this.normalizeSubtitles(file_obj.subtitles, file_obj.uid) : undefined;
    if (hasChapterPayload && file_obj.uid) {
      this.chapterCacheByUID.set(file_obj.uid, normalizedChapters);
    }
    if (hasSubtitlePayload && file_obj.uid) {
      this.subtitleCacheByUID.set(file_obj.uid, normalizedSubtitles);
    }
    const mediaObject: IMedia = {
      title: file_obj.title,
      src: this.createStreamURL(file_obj),
      type: mime_type,
      label: file_obj.title,
      url: file_obj.url,
      uid: file_obj.uid,
      chapters: normalizedChapters,
      subtitles: normalizedSubtitles,
      thumbnail: fileThumbnailURL(file_obj, this.baseStreamPath, this.postsService.isLoggedIn ? this.postsService.token : null, this.library),
      duration: formatDuration(file_obj.duration),
      uploader: file_obj.uploader || ''
    };
    return mediaObject;
  }

  createStreamURL(file_obj: DatabaseFile): string {
    const normalizedBaseStreamPath = this.baseStreamPath.endsWith('/')
      ? this.baseStreamPath.slice(0, -1)
      : this.baseStreamPath;
    let fullLocation = `${normalizedBaseStreamPath}/stream?uid=${encodeURIComponent(file_obj.uid)}`;

    fullLocation += `&type=${file_obj.isAudio ? 'audio' : 'video'}`;

    if (this.postsService.isLoggedIn) {
      fullLocation += `&jwt=${this.postsService.token}`;
    }

    if (this.uuid) {
      fullLocation += `&uuid=${this.uuid}`;
    }

    if (this.library) {
      fullLocation += `&library=${encodeURIComponent(this.library)}`;
    }

    if (this.sub_id) {
      fullLocation += `&sub_id=${this.sub_id}`;
    } else if (this.playlist_id) {
      fullLocation += `&playlist_id=${this.playlist_id}`;
    }

    return fullLocation;
  }

  createSubtitleTrackURL(uid: string, index = 0): string {
    const normalizedBaseStreamPath = this.baseStreamPath.endsWith('/')
      ? this.baseStreamPath.slice(0, -1)
      : this.baseStreamPath;
    let fullLocation = `${normalizedBaseStreamPath}/streamSubtitle?uid=${encodeURIComponent(uid)}&index=${index}`;

    if (this.postsService.isLoggedIn) {
      fullLocation += `&jwt=${this.postsService.token}`;
    }

    if (this.uuid) {
      fullLocation += `&uuid=${this.uuid}`;
    }

    if (this.library) {
      fullLocation += `&library=${encodeURIComponent(this.library)}`;
    }

    if (this.sub_id) {
      fullLocation += `&sub_id=${this.sub_id}`;
    } else if (this.playlist_id) {
      // Carried for the same reason the stream URL carries it: a shared playlist is what
      // authorizes this request, and the server checks the file is one of its members.
      fullLocation += `&playlist_id=${this.playlist_id}`;
    }

    return fullLocation;
  }

  shouldAutoloadWholeLibraryQueue(): boolean {
    return this.isSingleFileMode() && this.playlist.length <= 1;
  }

  isSingleFileMode(): boolean {
    return !!this.uid && !this.playlist_id && !this.sub_id;
  }

  collapseAutoplayQueueToCurrentItem(): void {
    if (!this.isSingleFileMode() || !this.autoplay_queue_initialized || !this.currentItem) {
      return;
    }
    this.playlist = [this.currentItem];
    this.currentIndex = 0;
    this.original_playlist = JSON.stringify(this.playlist);
    this.autoplay_queue_initialized = false;
  }

  ensureAutoplayQueueReady(): void {
    if (!this.shouldAutoloadWholeLibraryQueue() || this.autoplay_queue_loading || this.autoplay_queue_initialized) {
      return;
    }

    this.autoplay_queue_loading = true;
    const sort: Sort = {
      by: this.queue_sort_by,
      order: this.queue_sort_order
    };
    const fileTypeFilter = this.resolveQueueFileTypeFilter();
    const textSearch = this.queue_search?.trim() ? this.queue_search.trim() : null;
    const queueSubID = this.queue_sub_id || null;

    this.postsService.getAllFiles(sort, null, textSearch, fileTypeFilter, this.queue_favorite_filter, queueSubID, false, this.queue_category_filter_uids, this.library).subscribe(res => {
      if (!this.autoplay_enabled) {
        this.autoplay_queue_loading = false;
        this.pending_autoplay_advance = false;
        return;
      }

      this.autoplay_queue_loading = false;
      const files = res['files'] ?? [];
      if (files.length === 0) return;

      const current_uid = this.currentItem?.uid || this.uid;
      this.autoplay_queue_file_objs = files;
      const newPlaylist = files.map(file_obj => this.createMediaObject(file_obj));
      const currentIndex = newPlaylist.findIndex(file_obj => file_obj.uid === current_uid);
      if (currentIndex === -1) return;

      this.playlist = newPlaylist;
      this.updateCurrentItem(this.playlist[currentIndex], currentIndex);
      this.original_playlist = JSON.stringify(this.playlist);
      this.autoplay_queue_initialized = true;

      if (this.pending_autoplay_advance) {
        this.pending_autoplay_advance = false;
        this.advanceToNextVideo();
      }
    }, err => {
      console.error('Failed to load autoplay queue');
      console.error(err);
      this.autoplay_queue_loading = false;
      this.pending_autoplay_advance = false;
    });
  }

  syncCurrentSingleFileMetadata(): void {
    if (!this.isSingleFileMode() || !this.currentItem?.uid) {
      return;
    }

    const current_file = this.autoplay_queue_file_objs.find(file_obj => file_obj.uid === this.currentItem.uid);
    if (current_file) {
      this.db_file = current_file;
    }
  }

  syncCurrentFileMetadata(): void {
    const current_uid = this.currentItem?.uid;
    if (!current_uid) {
      this.currentFile = null;
      return;
    }

    if (this.playlist_id) {
      this.currentFile = this.file_objs.find(file_obj => file_obj.uid === current_uid) ?? null;
      return;
    }

    if (this.sub_id) {
      this.currentFile = this.subscription?.videos?.find(file_obj => file_obj.uid === current_uid) ?? null;
      return;
    }

    if (this.db_file?.uid === current_uid) {
      this.currentFile = this.db_file;
      return;
    }

    this.currentFile = this.autoplay_queue_file_objs.find(file_obj => file_obj.uid === current_uid) ?? null;
  }

  syncCurrentChapters(): void {
    const current_uid = this.currentItem?.uid;
    if (Array.isArray(this.currentItem?.chapters)) {
      this.currentChapters = this.currentItem.chapters;
      if (current_uid) {
        this.chapterCacheByUID.set(current_uid, this.currentChapters);
      }
    } else if (current_uid && this.chapterCacheByUID.has(current_uid)) {
      this.currentChapters = this.chapterCacheByUID.get(current_uid) ?? [];
      this.currentItem.chapters = this.currentChapters;
    } else {
      this.currentChapters = [];
    }

    this.refreshCurrentChapterState();
    this.ensureCurrentItemPlaybackMetadataLoaded();
    this.chapterDropdownOpen = false;
  }

  syncCurrentSubtitles(): void {
    const current_uid = this.currentItem?.uid;
    if (Array.isArray(this.currentItem?.subtitles)) {
      this.currentSubtitleTracks = this.currentItem.subtitles;
      if (current_uid) {
        this.subtitleCacheByUID.set(current_uid, this.currentSubtitleTracks);
      }
    } else if (current_uid && this.subtitleCacheByUID.has(current_uid)) {
      this.currentSubtitleTracks = this.subtitleCacheByUID.get(current_uid) ?? [];
      this.currentItem.subtitles = this.currentSubtitleTracks;
    } else {
      this.currentSubtitleTracks = [];
    }
  }

  normalizeChapters(chapters: DatabaseFile['chapters']): IChapter[] {
    if (!Array.isArray(chapters)) return [];

    return chapters
      .map(chapter => {
        const start_time = Number(chapter.start_time);
        const end_time = Number(chapter.end_time);
        const title = typeof chapter.title === 'string' ? chapter.title.trim() : '';
        if (!Number.isFinite(start_time) || start_time < 0) return null;
        if (!Number.isFinite(end_time) || end_time <= start_time) return null;
        if (!title) return null;
        return {title, start_time, end_time};
      })
      .filter((chapter): chapter is IChapter => !!chapter);
  }

  normalizeSubtitles(subtitles: DatabaseFile['subtitles'], uid: string = null): ISubtitleTrack[] {
    if (!Array.isArray(subtitles)) return [];

    return subtitles
      .map((subtitle, index) => {
        const label = typeof subtitle.label === 'string' ? subtitle.label.trim() : '';
        const language = typeof subtitle.language === 'string' ? subtitle.language.trim().toLowerCase() : '';
        if (!label || !language || !uid) return null;

        return {
          label,
          language,
          kind: typeof subtitle.kind === 'string' && subtitle.kind.trim() !== '' ? subtitle.kind.trim() : 'subtitles',
          default: subtitle.default === true || index === 0,
          src: this.createSubtitleTrackURL(uid, index)
        };
      })
      .filter(Boolean) as ISubtitleTrack[];
  }

  private unloadMediaElement(): void {
    const media_element = this.media;
    if (!media_element) {
      return;
    }

    try {
      media_element.pause?.();
    } catch (e) {
      // Non-fatal cleanup.
    }

    // Removing the sources before reloading aborts any in-flight fetch so route changes
    // do not trigger a fallback load against the current document.
    media_element.querySelectorAll?.('source').forEach(source => source.remove());
    media_element.removeAttribute?.('src');

    try {
      media_element.load?.();
    } catch (e) {
      // Non-fatal cleanup.
    }
  }

  isChapterActive(chapter: IChapter): boolean {
    return this.currentChapters[this.activeChapterIndex] === chapter;
  }

  jumpToChapter(chapter: IChapter): void {
    if (!this.media) return;
    const target_time = Math.floor(chapter.start_time);
    this.setPlaybackTimestamp(target_time);
    this.refreshCurrentChapterState(target_time);
  }

  toggleChapterDropdown(event: MouseEvent): void {
    event.stopPropagation();
    this.chapterDropdownOpen = !this.chapterDropdownOpen;
  }

  // A double-click on the picture lands on the play button drawn over it, not on the video the
  // player listens on, so it would never go full screen.
  onPlayerDoubleClick(event: MouseEvent): void {
    if (!(event.target as HTMLElement | null)?.closest?.('eva-overlay-play')) return;
    this.eva_player?.playerFullscreenAPI.toggleFullscreen().catch(() => undefined);
  }

  onPlayerPointerActivity(event: PointerEvent): void {
    this.revealTheaterToolbar();
    // The player only counts movement over the picture itself as activity, not over its bar or
    // the play button drawn on top of a paused video, so its controls would hide under the pointer.
    this.evaApi?.triggerUserInteraction.next(event);
    if (event.type === 'pointerdown') this.startSpeedHold(event);
  }

  onPlayerContextMenu(event: MouseEvent): void {
    // A long press on a touch screen opens the context menu; during a hold it is the hold.
    if (this.speed_hold) event.preventDefault();
  }

  // The picture is the play button the player draws over the video, whose click plays or pauses.
  private startSpeedHold(event: PointerEvent): void {
    const media = this.media;
    if (!event.isPrimary || event.button !== 0 || !media || media.ended || media.error) return;
    if (!(event.target as HTMLElement | null)?.closest?.('eva-overlay-play')) return;

    this.endSpeedHold();
    this.speed_hold = {
      src: media.currentSrc,
      start_x: event.clientX,
      start_y: event.clientY,
      timer: setTimeout(() => this.engageSpeedHold(), SPEED_HOLD_DELAY_MS),
      previous_rate: media.playbackRate,
      was_paused: media.paused
    };
    // On the window, so letting go anywhere ends the hold, not only over the video.
    window.addEventListener('pointermove', this.onSpeedHoldPointerMove);
    window.addEventListener('pointerup', this.onSpeedHoldRelease);
    window.addEventListener('pointercancel', this.onSpeedHoldRelease);
    window.addEventListener('blur', this.onSpeedHoldRelease);
  }

  private engageSpeedHold(): void {
    const hold = this.speed_hold;
    if (!hold || !this.media) return;
    hold.timer = null;
    this.media.playbackRate = SPEED_HOLD_RATE;
    if (hold.was_paused) this.playMedia();
    this.speed_hold_active = true;
  }

  private readonly onSpeedHoldPointerMove = (event: PointerEvent): void => {
    const hold = this.speed_hold;
    // Once engaged, the hold lasts until release wherever the pointer goes.
    if (!hold?.timer) return;
    const distance = Math.hypot(event.clientX - hold.start_x, event.clientY - hold.start_y);
    if (distance > SPEED_HOLD_MOVE_TOLERANCE_PX) this.endSpeedHold();
  };

  private readonly onSpeedHoldRelease = (): void => this.endSpeedHold();

  // Letting go of a hold is also a click, which would play or pause the video.
  private readonly swallowSpeedHoldClick = (event: MouseEvent): void => {
    if (!(event.target as HTMLElement | null)?.closest?.('eva-player')) return;
    event.stopPropagation();
    event.preventDefault();
  };

  private endSpeedHold(): void {
    const hold = this.speed_hold;
    if (!hold) return;
    this.speed_hold = null;
    window.removeEventListener('pointermove', this.onSpeedHoldPointerMove);
    window.removeEventListener('pointerup', this.onSpeedHoldRelease);
    window.removeEventListener('pointercancel', this.onSpeedHoldRelease);
    window.removeEventListener('blur', this.onSpeedHoldRelease);
    if (hold.timer) {
      clearTimeout(hold.timer);
      return;
    }

    this.speed_hold_active = false;
    // Loading the next file already reset the rate, and its paused state is its own.
    const media = this.media;
    if (media && media.currentSrc === hold.src) {
      media.playbackRate = hold.previous_rate;
      if (hold.was_paused && !media.paused) media.pause();
    }
    // The click that comes with this release is dispatched before the timeout runs.
    window.addEventListener('click', this.swallowSpeedHoldClick, true);
    setTimeout(() => window.removeEventListener('click', this.swallowSpeedHoldClick, true));
  }

  selectChapterFromDropdown(chapter: IChapter, event: MouseEvent): void {
    event.stopPropagation();
    this.jumpToChapter(chapter);
    this.chapterDropdownOpen = false;
  }

  getCurrentChapter(): IChapter | null {
    if (this.currentChapters.length === 0) return null;
    const current_time = this.media?.currentTime ?? 0;
    const active_chapter = this.currentChapters.find(chapter => current_time >= chapter.start_time && current_time < chapter.end_time);
    return active_chapter ?? this.currentChapters[0];
  }

  getCurrentChapterLabel(): string {
    return this.currentChapterLabel;
  }

  formatChapterTimestamp(total_seconds: number): string {
    const safe_seconds = Math.max(0, Math.floor(total_seconds || 0));
    const hours = Math.floor(safe_seconds / 3600);
    const minutes = Math.floor((safe_seconds % 3600) / 60);
    const seconds = safe_seconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  patchAutoplayQueueFile(updated_file: DatabaseFile): void {
    const idx = this.autoplay_queue_file_objs.findIndex(file_obj => file_obj.uid === updated_file.uid);
    if (idx >= 0) {
      this.autoplay_queue_file_objs[idx] = updated_file;
    }
  }

  onPlaybackTimeUpdate(): void {
    this.playbackTime = this.media?.currentTime ?? 0;
    this.refreshCurrentChapterState(this.playbackTime);
  }

  refreshCurrentChapterState(current_time = this.media?.currentTime ?? this.playbackTime): void {
    this.playbackTime = current_time;
    if (this.currentChapters.length === 0) {
      this.activeChapterIndex = -1;
      this.currentChapterLabel = $localize`Chapters`;
      return;
    }

    const next_active_index = this.currentChapters.findIndex(chapter => current_time >= chapter.start_time && current_time < chapter.end_time);
    this.activeChapterIndex = next_active_index >= 0 ? next_active_index : 0;
    this.currentChapterLabel = this.currentChapters[this.activeChapterIndex]?.title ?? $localize`Chapters`;
  }

  ensureCurrentItemPlaybackMetadataLoaded(): void {
    const current_uid = this.currentItem?.uid;
    if (!current_uid || this.chapterLoadInFlight.has(current_uid)) {
      return;
    }

    if (this.chapterCacheByUID.has(current_uid) && this.subtitleCacheByUID.has(current_uid)) {
      this.applyChaptersToMedia(current_uid, this.chapterCacheByUID.get(current_uid) ?? []);
      this.applySubtitlesToMedia(current_uid, this.subtitleCacheByUID.get(current_uid) ?? []);
      return;
    }

    this.chapterLoadInFlight.add(current_uid);
    this.postsService.getFile(current_uid, this.uuid, this.library).subscribe(res => {
      this.chapterLoadInFlight.delete(current_uid);
      const normalized_chapters = this.normalizeChapters(res?.file?.chapters);
      const normalized_subtitles = this.normalizeSubtitles(res?.file?.subtitles, current_uid);
      this.chapterCacheByUID.set(current_uid, normalized_chapters);
      this.subtitleCacheByUID.set(current_uid, normalized_subtitles);
      this.applyChaptersToMedia(current_uid, normalized_chapters);
      this.applySubtitlesToMedia(current_uid, normalized_subtitles);
    }, () => {
      this.chapterLoadInFlight.delete(current_uid);
    });
  }

  applyChaptersToMedia(uid: string, chapters: IChapter[]): void {
    const playlist_item = this.playlist.find(media => media.uid === uid);
    if (playlist_item) {
      playlist_item.chapters = chapters;
    }

    const current_queue_file = this.autoplay_queue_file_objs.find(file_obj => file_obj.uid === uid);
    if (current_queue_file) {
      current_queue_file.chapters = chapters;
    }

    if (this.db_file?.uid === uid) {
      this.db_file.chapters = chapters;
    }

    if (this.currentFile?.uid === uid) {
      this.currentFile.chapters = chapters;
    }

    if (this.currentItem?.uid === uid) {
      this.currentItem.chapters = chapters;
      this.currentChapters = chapters;
      this.refreshCurrentChapterState();
    }
  }

  applySubtitlesToMedia(uid: string, subtitles: ISubtitleTrack[]): void {
    const playlist_item = this.playlist.find(media => media.uid === uid);
    if (playlist_item) {
      playlist_item.subtitles = subtitles;
    }

    const current_queue_file = this.autoplay_queue_file_objs.find(file_obj => file_obj.uid === uid);
    if (current_queue_file) {
      current_queue_file.subtitles = subtitles.map(({label, language, kind, default: is_default}) => ({
        label,
        language,
        kind,
        default: is_default
      }));
    }

    if (this.db_file?.uid === uid) {
      this.db_file.subtitles = subtitles.map(({label, language, kind, default: is_default}) => ({
        label,
        language,
        kind,
        default: is_default
      }));
    }

    if (this.currentFile?.uid === uid) {
      this.currentFile.subtitles = subtitles.map(({label, language, kind, default: is_default}) => ({
        label,
        language,
        kind,
        default: is_default
      }));
    }

    if (this.currentItem?.uid === uid) {
      this.currentItem.subtitles = subtitles;
      this.currentSubtitleTracks = subtitles;
    }
  }

  resolveQueueFileTypeFilter(): FileTypeFilter {
    if (this.queue_file_type_filter) {
      return this.queue_file_type_filter;
    }
    if (this.db_file) {
      return this.db_file.isAudio ? FileTypeFilter.AUDIO_ONLY : FileTypeFilter.VIDEO_ONLY;
    }
    return FileTypeFilter.BOTH;
  }

  parseCategoryFilterUids(raw_value: string | null): string[] {
    if (!raw_value) {
      return [];
    }

    return raw_value.split(',')
      .map(category_uid => category_uid.trim())
      .filter(category_uid => !!category_uid);
  }

  advanceToNextVideo(): boolean {
    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.playlist.length) {
      return false;
    }
    this.updateCurrentItem(this.playlist[nextIndex], nextIndex);
    return true;
  }

  shuffleArray(array: unknown[]): void {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
  }
}
