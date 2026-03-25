import { Component, OnInit, HostListener, OnDestroy, AfterViewInit, ViewChild, ChangeDetectorRef, ElementRef } from '@angular/core';
import { VgApiService } from '@videogular/ngx-videogular/core';
import { PostsService } from 'app/posts.services';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { ShareMediaDialogComponent } from '../dialogs/share-media-dialog/share-media-dialog.component';
import { DatabaseFile, FileType, FileTypeFilter, Playlist, Sort } from '../../api-types';
import { TwitchChatComponent } from 'app/components/twitch-chat/twitch-chat.component';
import { VideoInfoDialogComponent } from 'app/dialogs/video-info-dialog/video-info-dialog.component';
import { saveAs } from 'file-saver';
import { filter, take } from 'rxjs/operators';

export interface IMedia {
  title: string;
  src: string;
  type: string;
  label: string;
  url: string;
  uid?: string;
  chapters?: IChapter[];
  subtitles?: ISubtitleTrack[];
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

const AUTOPLAY_STORAGE_KEY = 'player_autoplay_enabled';
const REPEAT_STORAGE_KEY = 'player_repeat_enabled';

@Component({
    selector: 'app-player',
    templateUrl: './player.component.html',
    styleUrls: ['./player.component.css'],
    standalone: false
})
export class PlayerComponent implements OnInit, AfterViewInit, OnDestroy {

  playlist: Array<IMedia> = [];
  original_playlist: string = null;
  playlist_updating = false;

  show_player = false;

  currentIndex = 0;
  currentItem: IMedia = null;
  api: VgApiService;
  api_ready = false;

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
  timestamp = null;
  auto = null;
  queue_sort_by = 'registered';
  queue_sort_order = -1;
  queue_file_type_filter: FileTypeFilter = null;
  queue_favorite_filter = false;
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

  save_volume_timer = null;
  original_volume = null;

  autoplay_enabled = false;
  repeat_enabled = false;
  autoplay_queue_loading = false;
  autoplay_queue_initialized = false;
  pending_autoplay_advance = false;
  autoplay_queue_file_objs: DatabaseFile[] = [];
  playbackTime = 0;
  currentChapters: IChapter[] = [];
  chapterTimelineVisible = false;
  chapterDropdownOpen = false;
  currentChapterLabel = $localize`Chapters`;
  activeChapterIndex = -1;
  chapterCacheByUID = new Map<string, IChapter[]>();
  subtitleCacheByUID = new Map<string, ISubtitleTrack[]>();
  chapterLoadInFlight = new Set<string>();
  currentSubtitleTracks: ISubtitleTrack[] = [];
  subtitleTrackActivationTimer: ReturnType<typeof setTimeout> | null = null;
  subtitleTrackList?: TextTrackList & EventTarget;
  subtitleTrackAddListener?: EventListener;
  subtitleTrackRefreshToken = 0;
  loadedSubtitleTrackSignature = '';
  subtitleToggleStateKey: string | null = null;
  subtitlesEnabled = false;

  @ViewChild('twitchchat') twitchChat: TwitchChatComponent;
  @ViewChild('media', {read: ElementRef}) mediaElement?: ElementRef<HTMLVideoElement>;

  ngOnInit(): void {
    this.initPlaybackModeToggles();
    this.playlist_id = this.route.snapshot.paramMap.get('playlist_id');
    this.uid = this.route.snapshot.paramMap.get('uid');
    this.sub_id = this.route.snapshot.paramMap.get('sub_id');
    this.url = this.route.snapshot.paramMap.get('url');
    this.name = this.route.snapshot.paramMap.get('name');
    this.uuid = this.route.snapshot.paramMap.get('uuid');
    this.timestamp = this.route.snapshot.paramMap.get('timestamp');
    this.auto = this.route.snapshot.paramMap.get('auto');
    this.queue_sort_by = this.route.snapshot.paramMap.get('queue_sort_by') ?? 'registered';
    this.queue_sort_order = this.parseSortOrder(this.route.snapshot.paramMap.get('queue_sort_order'));
    this.queue_file_type_filter = this.parseFileTypeFilter(this.route.snapshot.paramMap.get('queue_file_type_filter'));
    this.queue_favorite_filter = this.route.snapshot.paramMap.get('queue_favorite_filter') === 'true';
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

  ngOnDestroy(): void {
    // prevents volume save feature from running in the background
    clearInterval(this.save_volume_timer);
    if (this.subtitleTrackActivationTimer) {
      clearTimeout(this.subtitleTrackActivationTimer);
      this.subtitleTrackActivationTimer = null;
    }
    if (this.subtitleTrackList && this.subtitleTrackAddListener && typeof this.subtitleTrackList.removeEventListener === 'function') {
      this.subtitleTrackList.removeEventListener('addtrack', this.subtitleTrackAddListener);
      this.subtitleTrackAddListener = null;
      this.subtitleTrackList = null;
    }
    this.postsService.setPageTitle();
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.chapterDropdownOpen = false;
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
    this.postsService.getFile(this.uid, this.uuid).subscribe(res => {
      this.db_file = res['file'];
      if (!this.db_file) {
        this.postsService.openSnackBar($localize`Failed to get file information from the server.`, 'Dismiss');
        return;
      }
      this.postsService.incrementViewCount(this.db_file['uid'], null, this.uuid).subscribe(() => undefined, err => {
        console.error('Failed to increment view count');
        console.error(err);
      });
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
    this.postsService.getPlaylist(this.playlist_id, this.uuid, true).subscribe(res => {
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

  onPlayerReady(api: VgApiService): void {
      this.api = api;
      this.api_ready = true;
      this.cdr.detectChanges();
      this.attachSubtitleTrackListener();

      // checks if volume has been previously set. if so, use that as default
      if (localStorage.getItem('player_volume')) {
        this.api.volume = parseFloat(localStorage.getItem('player_volume'));
      }

      this.save_volume_timer = setInterval(() => this.saveVolume(this.api), 2000)

      this.api.getDefaultMedia().subscriptions.loadedMetadata.subscribe(() => {
        this.showDefaultSubtitleTrack();
        this.playVideo();
      });
      this.api.getDefaultMedia().subscriptions.ended.subscribe(this.nextVideo.bind(this));
      this.api.getDefaultMedia().subscriptions.timeUpdate.subscribe(this.onPlaybackTimeUpdate.bind(this));

      if (this.timestamp) {
        this.api.seekTime(+this.timestamp);
      }
  }

  saveVolume(api: VgApiService): void {
    if (this.original_volume !== api.volume) {
      localStorage.setItem('player_volume', api.volume)
      this.original_volume = api.volume;
    }
  }

  nextVideo(): void {
      if (this.repeat_enabled) {
        this.repeatCurrentVideo();
        return;
      }

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
    const current_subtitle_toggle_key = this.getSubtitleToggleStateKey(this.currentItem, this.currentIndex);
    const next_subtitle_toggle_key = this.getSubtitleToggleStateKey(newCurrentItem, newCurrentIndex);
    if (current_subtitle_toggle_key !== next_subtitle_toggle_key) {
      this.subtitleToggleStateKey = null;
      this.subtitlesEnabled = false;
    }
    if (this.currentItem?.uid !== newCurrentItem?.uid) {
      this.subtitleTrackRefreshToken += 1;
      this.loadedSubtitleTrackSignature = '';
    }
    this.currentItem  = newCurrentItem;
    this.currentIndex = newCurrentIndex;
    this.playbackTime = 0;
    this.chapterTimelineVisible = false;
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

  playVideo(): void {
      this.api.play();
  }

  onClickPlaylistItem(item: IMedia, index: number): void {
      this.updateCurrentItem(item, index);
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
    const zipName = this.db_playlist.name;
    this.downloading = true;
    this.postsService.downloadPlaylistFromServer(this.playlist_id, this.uuid).subscribe(res => {
      this.downloading = false;
      const blob: Blob = res;
      saveAs(blob, zipName + '.zip');
    }, err => {
      console.error(err);
      this.downloading = false;
    });
  }

  downloadFile(): void {
    const filename = this.currentItem?.title ?? this.playlist[0]?.title;
    const ext = (this.currentItem?.type === 'audio/mp3') ? '.mp3' : '.mp4';
    const uid = this.currentItem?.uid ?? this.uid;
    this.downloading = true;
    this.postsService.downloadFileFromServer(uid, this.uuid).subscribe(res => {
      this.downloading = false;
      const blob: Blob = res;
      saveAs(blob, filename + ext);
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
        current_timestamp: this.api.time.current
      },
      width: '60vw'
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
      },
      minWidth: '50vw'
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
    });
  }

  getPlaylistFileIndexUID(uid: string): number {
    return this.file_objs.findIndex(file_obj => file_obj['uid'] === uid);
  }

  setPlaybackTimestamp(time: number): void {
    this.api.seekTime(time);
    this.playbackTime = time;
    this.refreshCurrentChapterState(time);
  }

  togglePlayback(to_play: boolean): void {
    if (to_play) {
      this.api.play();
    } else {
      this.api.pause();
    }
  }

  setPlaybackRate(speed: number): void {
    this.api.playbackRate = speed;
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
      subtitles: normalizedSubtitles
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
    } else if (this.postsService.auth_token) {
      fullLocation += `&apiKey=${this.postsService.auth_token}`;
    }

    if (this.uuid) {
      fullLocation += `&uuid=${this.uuid}`;
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
    } else if (this.postsService.auth_token) {
      fullLocation += `&apiKey=${this.postsService.auth_token}`;
    }

    if (this.uuid) {
      fullLocation += `&uuid=${this.uuid}`;
    }

    if (this.sub_id) {
      fullLocation += `&sub_id=${this.sub_id}`;
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

    this.postsService.getAllFiles(sort, null, textSearch, fileTypeFilter, this.queue_favorite_filter, queueSubID, false).subscribe(res => {
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
    this.chapterTimelineVisible = false;
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
    this.syncSubtitleToggleState();
    this.refreshMediaSubtitleTracks();
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

  getSubtitleTrackSignature(subtitles: ISubtitleTrack[] = []): string {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return '';
    return subtitles
      .map(subtitle => `${subtitle.language ?? ''}:${subtitle.label ?? ''}:${subtitle.src ?? ''}:${subtitle.default === true}`)
      .join('|');
  }

  getSubtitleToggleStateKey(item: IMedia = this.currentItem, item_index = this.currentIndex): string | null {
    if (!item) return null;
    return item.uid || item.url || `${item_index}:${item.title ?? ''}`;
  }

  canToggleSubtitles(): boolean {
    return this.currentItem?.type !== 'audio/mp3' && this.currentSubtitleTracks.length > 0;
  }

  getSubtitleToggleTooltip(): string {
    return this.subtitlesEnabled
      ? $localize`Hide subtitles`
      : $localize`Show subtitles`;
  }

  syncSubtitleToggleState(): void {
    if (!this.canToggleSubtitles()) {
      this.subtitlesEnabled = false;
      return;
    }

    const subtitle_toggle_key = this.getSubtitleToggleStateKey();
    if (subtitle_toggle_key && this.subtitleToggleStateKey !== subtitle_toggle_key) {
      this.subtitleToggleStateKey = subtitle_toggle_key;
      this.subtitlesEnabled = true;
    }
  }

  disableSubtitleTracks(): void {
    const media_element = this.mediaElement?.nativeElement;
    if (!media_element?.textTracks) return;

    for (let i = 0; i < media_element.textTracks.length; i++) {
      media_element.textTracks[i].mode = 'disabled';
    }
  }

  toggleSubtitles(): void {
    if (!this.canToggleSubtitles()) return;
    this.subtitlesEnabled = !this.subtitlesEnabled;
    this.showDefaultSubtitleTrack();
  }

  refreshMediaSubtitleTracks(): void {
    const media_element = this.mediaElement?.nativeElement;
    const subtitle_signature = this.getSubtitleTrackSignature(this.currentSubtitleTracks);

    if (!media_element || this.currentItem?.type === 'audio/mp3') {
      this.loadedSubtitleTrackSignature = subtitle_signature;
      queueMicrotask(() => this.showDefaultSubtitleTrack());
      return;
    }

    this.cdr.detectChanges();
    queueMicrotask(() => {
      this.attachSubtitleTrackListener();
      const should_reload_media = media_element.readyState > 0
        && subtitle_signature !== this.loadedSubtitleTrackSignature
        && typeof media_element.load === 'function';

      this.loadedSubtitleTrackSignature = subtitle_signature;
      if (!should_reload_media) {
        this.showDefaultSubtitleTrack();
        return;
      }

      const refresh_token = ++this.subtitleTrackRefreshToken;
      const current_uid = this.currentItem?.uid ?? null;
      const resume_playback = !media_element.paused && !media_element.ended;
      const resume_time = Number.isFinite(media_element.currentTime) ? media_element.currentTime : 0;
      const restore_media_state = () => {
        if (refresh_token !== this.subtitleTrackRefreshToken || current_uid !== (this.currentItem?.uid ?? null)) {
          return;
        }

        if (resume_time > 0) {
          try {
            const duration = Number.isFinite(media_element.duration) && media_element.duration > 0
              ? media_element.duration
              : resume_time;
            media_element.currentTime = Math.min(resume_time, duration);
          } catch (e) {
            // Non-fatal.
          }
        }

        this.showDefaultSubtitleTrack();
        if (resume_playback) {
          try {
            const play_result = media_element.play();
            if (play_result && typeof play_result.catch === 'function') {
              play_result.catch(() => undefined);
            }
          } catch (e) {
            // Non-fatal.
          }
        }
      };

      media_element.addEventListener('loadedmetadata', restore_media_state, { once: true });
      media_element.load();
    });
  }

  showDefaultSubtitleTrack(): void {
    const media_element = this.mediaElement?.nativeElement;
    if (!media_element || !media_element.textTracks) return;

    if (this.currentSubtitleTracks.length === 0 || !this.subtitlesEnabled) {
      this.disableSubtitleTracks();
      return;
    }

    if (media_element.textTracks.length === 0) {
      this.scheduleDefaultSubtitleTrackActivation();
      return;
    }

    const default_track_index = Math.max(0, this.currentSubtitleTracks.findIndex(track => track.default));
    for (let i = 0; i < media_element.textTracks.length; i++) {
      media_element.textTracks[i].mode = i === default_track_index ? 'showing' : 'disabled';
    }
  }

  attachSubtitleTrackListener(): void {
    const media_element = this.mediaElement?.nativeElement;
    const text_tracks = media_element?.textTracks as (TextTrackList & EventTarget) | undefined;
    if (!text_tracks || typeof text_tracks.addEventListener !== 'function') return;

    if (this.subtitleTrackList && this.subtitleTrackAddListener && typeof this.subtitleTrackList.removeEventListener === 'function') {
      this.subtitleTrackList.removeEventListener('addtrack', this.subtitleTrackAddListener);
    }

    this.subtitleTrackList = text_tracks;
    this.subtitleTrackAddListener = () => {
      queueMicrotask(() => this.showDefaultSubtitleTrack());
    };
    text_tracks.addEventListener('addtrack', this.subtitleTrackAddListener);
  }

  scheduleDefaultSubtitleTrackActivation(): void {
    if (this.subtitleTrackActivationTimer) {
      clearTimeout(this.subtitleTrackActivationTimer);
    }
    this.subtitleTrackActivationTimer = setTimeout(() => {
      this.subtitleTrackActivationTimer = null;
      this.showDefaultSubtitleTrack();
    }, 150);
  }

  isChapterActive(chapter: IChapter): boolean {
    return this.currentChapters[this.activeChapterIndex] === chapter;
  }

  jumpToChapter(chapter: IChapter): void {
    if (!this.api) return;
    const target_time = Math.floor(chapter.start_time);
    this.setPlaybackTimestamp(target_time);
    this.refreshCurrentChapterState(target_time);
  }

  toggleChapterDropdown(event: MouseEvent): void {
    event.stopPropagation();
    this.chapterDropdownOpen = !this.chapterDropdownOpen;
  }

  onPlayerMouseMove(event: MouseEvent): void {
    if (this.currentItem?.type === 'audio/mp3' || this.currentChapters.length === 0) {
      this.chapterTimelineVisible = false;
      return;
    }

    const player_element = event.currentTarget as HTMLElement | null;
    if (!player_element) return;

    const player_rect = player_element.getBoundingClientRect();
    const distance_from_bottom = player_rect.bottom - event.clientY;
    const hover_height = this.getChapterTimelineHoverHeight(player_element.clientHeight);

    this.chapterTimelineVisible = distance_from_bottom >= 0 && distance_from_bottom <= hover_height;
  }

  onPlayerMouseLeave(): void {
    this.chapterTimelineVisible = false;
  }

  selectChapterFromDropdown(chapter: IChapter, event: MouseEvent): void {
    event.stopPropagation();
    this.jumpToChapter(chapter);
    this.chapterDropdownOpen = false;
  }

  getCurrentChapter(): IChapter | null {
    if (this.currentChapters.length === 0) return null;
    const current_time = this.api?.currentTime ?? 0;
    const active_chapter = this.currentChapters.find(chapter => current_time >= chapter.start_time && current_time < chapter.end_time);
    return active_chapter ?? this.currentChapters[0];
  }

  getCurrentChapterLabel(): string {
    return this.currentChapterLabel;
  }

  getChapterTimelineDuration(): number {
    const last_chapter_end = this.currentChapters[this.currentChapters.length - 1]?.end_time ?? 0;
    const file_duration = Number(this.currentFile?.duration ?? this.db_file?.duration ?? 0);
    return Math.max(last_chapter_end, Number.isFinite(file_duration) ? file_duration : 0);
  }

  getChapterTimelineHoverHeight(player_height: number): number {
    return Math.max(96, Math.min(player_height * 0.2, 132));
  }

  getChapterSegmentFlex(chapter: IChapter): number {
    return Math.max(chapter.end_time - chapter.start_time, 1);
  }

  getChapterProgressWidth(chapter: IChapter): number {
    const duration = chapter.end_time - chapter.start_time;
    if (duration <= 0) return 0;

    const elapsed = Math.min(Math.max(this.playbackTime - chapter.start_time, 0), duration);
    return (elapsed / duration) * 100;
  }

  getActiveChapterPositionLabel(): string {
    if (this.currentChapters.length === 0 || this.activeChapterIndex < 0) {
      return '';
    }

    return `${this.activeChapterIndex + 1}/${this.currentChapters.length}`;
  }

  getChapterTooltip(chapter: IChapter): string {
    return `${this.formatChapterTimestamp(chapter.start_time)} - ${this.formatChapterTimestamp(chapter.end_time)}  ${chapter.title}`;
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
    this.playbackTime = this.api?.currentTime ?? 0;
    this.refreshCurrentChapterState(this.playbackTime);
  }

  refreshCurrentChapterState(current_time = this.api?.currentTime ?? this.playbackTime): void {
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
    this.postsService.getFile(current_uid, this.uuid).subscribe(res => {
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
      this.syncSubtitleToggleState();
      this.refreshMediaSubtitleTracks();
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

  repeatCurrentVideo(): void {
    if (!this.api) return;
    this.api.seekTime(0);
    this.api.play();
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
