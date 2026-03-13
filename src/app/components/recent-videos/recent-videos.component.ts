import { Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { Router } from '@angular/router';
import { DatabaseFile, FileType, FileTypeFilter, Playlist, Sort } from '../../../api-types';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, filter, take } from 'rxjs/operators';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatChipListboxChange } from '@angular/material/chips';
import { MatSelectionListChange } from '@angular/material/list';
import { saveAs } from 'file-saver';
import { MatDialog } from '@angular/material/dialog';
import { CreatePlaylistComponent } from 'app/create-playlist/create-playlist.component';

type PageSizeOption = number | 'auto';

@Component({
    selector: 'app-recent-videos',
    templateUrl: './recent-videos.component.html',
    styleUrls: ['./recent-videos.component.scss'],
    standalone: false
})
export class RecentVideosComponent implements OnInit, OnDestroy {
  readonly pageSizeStorageKey = 'recent_videos_page_size';
  readonly libraryTabStorageKey = 'recent_videos_library_tab';
  readonly autoPageSizeOption: PageSizeOption = 'auto';
  readonly autoPageBatchSize = 25;
  readonly pageSizeOptions: PageSizeOption[] = [5, 10, 25, 100, 250, this.autoPageSizeOption];

  @Input() usePaginator = true;

  // File selection

  @Input() selectMode = false;
  @Input() defaultSelected: DatabaseFile[] = [];
  @Input() sub_id = null;
  @Input() customHeader = null;
  @Input() selectedIndex = 1;
  @Output() fileSelectionEmitter = new EventEmitter<{new_selection: string[], thumbnailURL: string}>();

  pageSize = 10;
  paged_data: DatabaseFile[] = null;
  manualPageIndex = 0;
  autoPaginationEnabled = false;
  autoPageLoadInProgress = false;

  selected_data: string[] = [];
  selected_data_objs: DatabaseFile[] = [];
  reverse_order = false;

  // File listing (with cards)

  cached_file_count = 0;
  loading_files = null;

  normal_files_received = false;
  subscription_files_received = false;
  file_count = 10;
  searchChangedSubject: Subject<string> = new Subject<string>();
  downloading_content = {};
  search_mode = false;
  search_text = '';
  searchIsFocused = false;
  descendingMode = true;
  activeLibraryTab = 0;
  playlistSearchText = '';
  playlistSearchIsFocused = false;

  fileFilters = {
    video_only: {
      key: 'video_only',
      label: $localize`Video only`,
      incompatible: ['audio_only']
    },
    audio_only: {
      key: 'audio_only',
      label: $localize`Audio only`,
      incompatible: ['video_only']
    },
    favorited: {
      key: 'favorited',
      label: $localize`Favorited`
    },
  };

  selectedFilters = [];

  sortProperty = 'registered';
  
  playlists: Playlist[] = [];
  playlistLibraryItems: Playlist[] = [];
  playlistLibraryReceived = false;
  playlistLoadingCards = Array(6).fill(0);

  private autoLoadObserver: IntersectionObserver = null;
  private autoLoadAnchorElement: HTMLElement = null;
  private latestFileRequestId = 0;

  @ViewChild('autoLoadAnchor')
  set autoLoadAnchor(anchor: ElementRef<HTMLElement> | undefined) {
    this.autoLoadAnchorElement = anchor?.nativeElement ?? null;
    this.syncAutoLoadObserver();
  }

  constructor(public postsService: PostsService, private router: Router, private dialog: MatDialog, private ngZone: NgZone) {
    const saved_page_size = localStorage.getItem(this.pageSizeStorageKey);
    if (saved_page_size === this.autoPageSizeOption) {
      this.autoPaginationEnabled = true;
    } else {
      const saved_page_size_number = Number(saved_page_size);
      if ([5, 10, 25, 100, 250].includes(saved_page_size_number)) {
        this.pageSize = saved_page_size_number;
      }
    }

    const saved_library_tab = +localStorage.getItem(this.libraryTabStorageKey);
    if ([0, 1].includes(saved_library_tab)) {
      this.activeLibraryTab = saved_library_tab;
    }

    // get cached file count
    const sub_id_appendix = this.sub_id ? `_${this.sub_id}` : ''
    if (localStorage.getItem(`cached_file_count${sub_id_appendix}`)) {
      this.cached_file_count = +localStorage.getItem(`cached_file_count${sub_id_appendix}`) <= 10 ? +localStorage.getItem(`cached_file_count${sub_id_appendix}`) : 10;
      this.loading_files = Array(this.cached_file_count).fill(0);
    }

    if (!this.loading_files) {
      this.loading_files = Array(this.getLoadingPlaceholderCount()).fill(0);
    }

    // set filter property to cached value
    const cached_sort_property = localStorage.getItem('sort_property');
    if (cached_sort_property) {
      this.sortProperty = cached_sort_property;
    }

    // set file type filter to cached value
    const cached_file_filter = localStorage.getItem('file_filter');
    if (this.usePaginator && cached_file_filter) {
      this.selectedFilters = JSON.parse(cached_file_filter)
    } else {
      this.selectedFilters = [];
    }

    const sort_order = localStorage.getItem('recent_videos_sort_order');

    if (sort_order) {
      this.descendingMode = sort_order === 'descending';
    }
  }

  ngOnInit(): void {
    if (this.sub_id) {
      // subscriptions can't download both audio and video (for now), so don't let users filter for these
      delete this.fileFilters['audio_only'];
      delete this.fileFilters['video_only'];
    }

    if (this.postsService.initialized) {
      this.getAllFiles();
      this.getAvailablePlaylists();
      if (this.showLibraryTabs) {
        this.getPlaylistLibraryItems();
      }
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => {
          this.getAllFiles();
          this.getAvailablePlaylists();
          if (this.showLibraryTabs) {
            this.getPlaylistLibraryItems();
          }
        });
    }

    this.postsService.files_changed.subscribe(changed => {
      if (changed) {
        this.getAllFiles();
      }
    });

    this.postsService.playlists_changed.subscribe(changed => {
      if (changed) {
        this.getAvailablePlaylists();
        if (this.showLibraryTabs) {
          this.getPlaylistLibraryItems();
        }
      }
    });

    
    this.selected_data = this.defaultSelected.map(file => file.uid);
    this.selected_data_objs = this.defaultSelected;    

    this.searchChangedSubject
      .pipe(
        debounceTime(500),
        distinctUntilChanged()
      ).subscribe(model => {
        if (model.length > 0) {
          this.search_mode = true;
        } else {
          this.search_mode = false;
        }
        if (!this.showLibraryTabs || this.activeLibraryTab === 0) {
          this.getAllFiles();
        }
      });
  }

  ngOnDestroy(): void {
    this.disconnectAutoLoadObserver();
  }

  get showLibraryTabs(): boolean {
    return !this.selectMode && !this.sub_id;
  }

  get showPaginationControls(): boolean {
    return this.usePaginator && this.selectedIndex > 0;
  }

  get pageSizeSelectorValue(): PageSizeOption {
    return this.autoPaginationEnabled ? this.autoPageSizeOption : this.pageSize;
  }

  get showAutoLoadAnchor(): boolean {
    return this.showPaginationControls
      && this.autoPaginationEnabled
      && this.normal_files_received
      && this.isVideoLibraryActive()
      && (this.paged_data?.length ?? 0) > 0
      && (this.paged_data?.length ?? 0) < this.file_count;
  }

  getAllPlaylists(): void {
    this.getAvailablePlaylists();
    if (this.showLibraryTabs) {
      this.getPlaylistLibraryItems();
    }
  }

  getAvailablePlaylists(): void {
    this.postsService.getPlaylists().subscribe(res => {
      this.playlists = res['playlists'];
    });
  }

  getPlaylistLibraryItems(): void {
    this.playlistLibraryReceived = false;
    this.postsService.getPlaylists(true).subscribe(res => {
      this.playlistLibraryItems = res['playlists'];
      this.playlistLibraryReceived = true;
    });
  }

  get visiblePlaylists(): Playlist[] {
    const normalized_search_text = this.playlistSearchText.trim().toLowerCase();
    const filtered_playlists = this.playlistLibraryItems.filter(playlist => {
      if (!normalized_search_text) {
        return true;
      }

      const playlist_title = (playlist.name || '').toLowerCase();
      return playlist_title.includes(normalized_search_text);
    });

    return filtered_playlists.slice().sort((a, b) => this.comparePlaylistValues(a, b));
  }

  // search

  onSearchInputChanged(newvalue: string): void {
    this.normal_files_received = false;
    this.searchChangedSubject.next(newvalue);
  }

  onPlaylistSearchInputChanged(newvalue: string): void {
    this.playlistSearchText = newvalue;
  }

  libraryTabChanged(index: number): void {
    this.activeLibraryTab = index;
    localStorage.setItem(this.libraryTabStorageKey, `${index}`);
    this.syncAutoLoadObserver();

    if (index === 0) {
      this.getAllFiles();
      return;
    }

    if (this.showLibraryTabs && !this.playlistLibraryReceived) {
      this.getPlaylistLibraryItems();
    }
  }

  sortOptionChanged(value: Sort): void {
    localStorage.setItem('sort_property', value['by']);
    localStorage.setItem('recent_videos_sort_order', value['order'] === -1 ? 'descending' : 'ascending');
    this.descendingMode = value['order'] === -1;
    this.sortProperty = value['by'];
    
    if (!this.showLibraryTabs || this.activeLibraryTab === 0) {
      this.getAllFiles();
    }
  }

  filterChanged(value: string): void {
    localStorage.setItem('file_filter', value);
    // wait a bit for the animation to finish
    setTimeout(() => this.getAllFiles(), 150);
  }

  selectedFiltersChanged(event: MatChipListboxChange): void {
    // in some cases this function will fire even if the selected filters haven't changed
    if (event.value.length === this.selectedFilters.length) return;
    if (event.value.length > this.selectedFilters.length) {
      const filter_key = event.value.filter(possible_new_key => !this.selectedFilters.includes(possible_new_key))[0];
      this.selectedFilters = this.selectedFilters.filter(existing_filter => !this.fileFilters[existing_filter].incompatible || !this.fileFilters[existing_filter].incompatible.includes(filter_key));
      this.selectedFilters.push(filter_key);
    } else {
      this.selectedFilters = event.value;
    }
    this.filterChanged(JSON.stringify(this.selectedFilters));
  }

  getFileTypeFilter(): string {
    if (this.selectedFilters.includes('audio_only')) {
      return 'audio_only';
    } else if (this.selectedFilters.includes('video_only')) {
      return 'video_only';
    } else {
      return 'both';
    }
  }

  getFavoriteFilter(): boolean {
    return this.selectedFilters.includes('favorited');
  }


  // get files

  getAllFiles(cache_mode = false, append = false): void {
    if (append && (!this.autoPaginationEnabled || this.autoPageLoadInProgress || (this.paged_data?.length ?? 0) >= this.file_count)) {
      return;
    }

    if (!append) {
      this.normal_files_received = cache_mode;
      if (!cache_mode) {
        this.loading_files = Array(this.getLoadingPlaceholderCount()).fill(0);
      }
    } else {
      this.autoPageLoadInProgress = true;
    }

    const request_id = ++this.latestFileRequestId;
    const sort = {by: this.sortProperty, order: this.descendingMode ? -1 : 1};
    const range = this.getRequestedFileRange(cache_mode, append);
    const fileTypeFilter = this.getFileTypeFilter();
    const favoriteFilter = this.getFavoriteFilter();
    this.postsService.getAllFiles(sort, this.usePaginator ? range : null, this.search_mode ? this.search_text : null, fileTypeFilter as FileTypeFilter, favoriteFilter, this.sub_id).subscribe(res => {
      if (request_id !== this.latestFileRequestId) {
        return;
      }

      this.file_count = res['file_count'];
      const files = this.normalizeFiles(res['files'] ?? []);
      this.paged_data = append ? this.mergeFiles(this.paged_data ?? [], files) : files;

      // set cached file count for future use, note that we convert the amount of files to a string
      localStorage.setItem('cached_file_count', '' + this.file_count);

      this.normal_files_received = true;
      this.autoPageLoadInProgress = false;
      this.syncAutoLoadObserver();
    }, err => {
      if (request_id !== this.latestFileRequestId) {
        return;
      }
      console.error(err);
      this.autoPageLoadInProgress = false;
    });
  }

  // navigation

  goToFile(info_obj) {
    const file = info_obj['file'];
    const event = info_obj['event'];
    if (this.postsService.config['Extra']['download_only_mode']) {
      this.downloadFile(file);
    } else {
      this.navigateToFile(file, event.ctrlKey);
    }
  }

  navigateToFile(file: DatabaseFile, new_tab: boolean): void {
    localStorage.setItem('player_navigator', this.router.url);
    const routeParams = this.getPlayerRouteParams(file);
    if (!new_tab) {
      this.router.navigate(['/player', routeParams]);
    } else {
      const routeURL = this.router.serializeUrl(this.router.createUrlTree(['/player', routeParams]));
      window.open(`/#${routeURL}`);
    }
  }

  getPlayerRouteParams(file: DatabaseFile): Record<string, string> {
    const routeParams: Record<string, string> = {
      type: file.isAudio ? 'audio' : 'video',
      uid: file.uid,
      queue_sort_by: this.sortProperty,
      queue_sort_order: this.descendingMode ? '-1' : '1',
      queue_file_type_filter: this.getFileTypeFilter(),
      queue_favorite_filter: '' + this.getFavoriteFilter()
    };
    if (this.search_mode && this.search_text?.trim()) {
      routeParams.queue_search = this.search_text.trim();
    }
    if (this.sub_id) {
      routeParams.queue_sub_id = this.sub_id;
    }
    return routeParams;
  }

  goToSubscription(file: DatabaseFile): void {
    this.router.navigate(['/subscription', {id: file.sub_id}]);
  }

  // downloading

  downloadFile(file: DatabaseFile): void {
    const type = (file.isAudio ? 'audio' : 'video') as FileType;
    const ext = type === 'audio' ? '.mp3' : '.mp4'
    const name = file.id;
    this.downloading_content[file.uid] = true;
    this.postsService.downloadFileFromServer(file.uid).subscribe(res => {
      this.downloading_content[file.uid] = false;
      const blob: Blob = res;
      saveAs(blob, decodeURIComponent(name) + ext);

      if (!this.postsService.config.Extra.file_manager_enabled && !file.sub_id) {
        // tell server to delete the file once downloaded
        this.postsService.deleteFile(file.uid).subscribe(() => {
          // reload files
          this.getAllFiles();
        });
      }
    });
  }

  // deleting

  deleteFile(args) {
    const file = args.file;
    const blacklistMode = args.blacklistMode;

    if (file.sub_id) {
      this.deleteSubscriptionFile(file, blacklistMode);
    } else {
      this.deleteNormalFile(file, blacklistMode);
    }
  }

  deleteNormalFile(file: DatabaseFile, blacklistMode = false): void {
    this.postsService.deleteFile(file.uid, blacklistMode).subscribe(result => {
      if (result) {
        this.postsService.openSnackBar($localize`Delete success!`, $localize`OK.`);
        this.removeFileCard(file);
      } else {
        this.postsService.openSnackBar($localize`Delete failed!`, $localize`OK.`);
      }
    }, () => {
      this.postsService.openSnackBar($localize`Delete failed!`, $localize`OK.`);
    });
  }

  deleteSubscriptionFile(file: DatabaseFile, blacklistMode = false): void {
    if (blacklistMode) {
      this.deleteForever(file);
    } else {
      this.deleteAndRedownload(file);
    }
  }

  deleteAndRedownload(file: DatabaseFile): void {
    this.postsService.deleteSubscriptionFile(file.uid, false).subscribe(() => {
      this.postsService.openSnackBar($localize`Successfully deleted file: ` + file.id);
      this.removeFileCard(file);
    });
  }

  deleteForever(file: DatabaseFile): void {
    this.postsService.deleteSubscriptionFile(file.uid, true).subscribe(() => {
      this.postsService.openSnackBar($localize`Successfully deleted file: ` + file.id);
      this.removeFileCard(file);
    });
  }

  removeFileCard(file_to_remove: DatabaseFile): void {
    const index = this.paged_data.map(e => e.uid).indexOf(file_to_remove.uid);
    this.paged_data.splice(index, 1);
    this.getAllFiles(true);
  }

  // TODO: Add translation support for these snackbars
  addFileToPlaylist(info_obj) {
    const file = info_obj['file'];
    const playlist_id = info_obj['playlist_id'];
    const playlist = this.playlists.find(potential_playlist => potential_playlist['id'] === playlist_id);
    this.postsService.addFileToPlaylist(playlist_id, file['uid']).subscribe(res => {
      if (res['success']) {
        this.postsService.openSnackBar(`Successfully added ${file.title} to ${playlist?.name || 'playlist'}!`);
        this.postsService.playlists_changed.next(true);
      } else {
        this.postsService.openSnackBar(`Failed to add ${file.title} to ${playlist?.name || 'playlist'}! Unknown error.`);
      }
    }, err => {
      console.error(err);
      this.postsService.openSnackBar(`Failed to add ${file.title} to ${playlist?.name || 'playlist'}! See browser console for error.`);
    });
  }

  comparePlaylistValues(a: Playlist, b: Playlist): number {
    const direction = this.descendingMode ? -1 : 1;

    let left_value: string | number;
    let right_value: string | number;

    switch (this.sortProperty) {
      case 'title':
        left_value = (a.name || '').toLowerCase();
        right_value = (b.name || '').toLowerCase();
        break;
      case 'duration':
        left_value = a.duration ?? 0;
        right_value = b.duration ?? 0;
        break;
      case 'registered':
      default:
        left_value = a.registered ?? 0;
        right_value = b.registered ?? 0;
        break;
    }

    if (left_value < right_value) {
      return direction;
    }
    if (left_value > right_value) {
      return -direction;
    }
    return 0;
  }

  // sorting and filtering

  sortFiles(a: DatabaseFile, b: DatabaseFile): number {
    // uses the 'registered' flag as the timestamp
    const result = b.registered - a.registered;
    return result;
  }

  durationStringToNumber(dur_str: string): number {
    let num_sum = 0;
    const dur_str_parts = dur_str.split(':');
    for (let i = dur_str_parts.length - 1; i >= 0; i--) {
      num_sum += parseInt(dur_str_parts[i]) * (60 ** (dur_str_parts.length - 1 - i));
    }
    return num_sum;
  }

  getLoadingPlaceholderCount(): number {
    return this.autoPaginationEnabled ? this.autoPageBatchSize : this.pageSize;
  }

  getRequestedFileRange(cache_mode = false, append = false): number[] {
    if (this.autoPaginationEnabled) {
      if (append) {
        const start = this.paged_data?.length ?? 0;
        return [start, start + this.autoPageBatchSize];
      }

      const target_count = cache_mode && Array.isArray(this.paged_data) && this.paged_data.length > 0
        ? Math.max(this.paged_data.length, this.autoPageBatchSize)
        : this.autoPageBatchSize;
      return [0, target_count];
    }

    const current_file_index = this.manualPageIndex * this.pageSize;
    return [current_file_index, current_file_index + this.pageSize];
  }

  normalizeFiles(files: DatabaseFile[]): DatabaseFile[] {
    return files.map(file => {
      const normalized_file = {...file};
      normalized_file.duration = typeof normalized_file.duration !== 'string'
        ? normalized_file.duration
        : this.durationStringToNumber(normalized_file.duration);
      return normalized_file;
    });
  }

  mergeFiles(existing_files: DatabaseFile[], new_files: DatabaseFile[]): DatabaseFile[] {
    const existing_uids = new Set(existing_files.map(file => file.uid));
    const merged_files = existing_files.slice();
    for (const file of new_files) {
      if (existing_uids.has(file.uid)) continue;
      existing_uids.add(file.uid);
      merged_files.push(file);
    }
    return merged_files;
  }

  isVideoLibraryActive(): boolean {
    return !this.showLibraryTabs || this.activeLibraryTab === 0;
  }

  pageSizeOptionChanged(page_size_option: PageSizeOption): void {
    const should_enable_auto = page_size_option === this.autoPageSizeOption;
    if (should_enable_auto === this.autoPaginationEnabled && (should_enable_auto || page_size_option === this.pageSize)) {
      return;
    }

    this.autoPaginationEnabled = should_enable_auto;
    if (!should_enable_auto) {
      this.pageSize = page_size_option as number;
    }

    this.manualPageIndex = 0;
    localStorage.setItem(this.pageSizeStorageKey, should_enable_auto ? `${this.autoPageSizeOption}` : `${this.pageSize}`);
    this.loading_files = Array(this.getLoadingPlaceholderCount()).fill(0);
    this.getAllFiles();
  }

  formatPageSizeOption(page_size_option: PageSizeOption): string {
    return page_size_option === this.autoPageSizeOption ? $localize`Auto` : `${page_size_option}`;
  }

  getPageSizeTriggerLabel(page_size_option: PageSizeOption): string {
    return page_size_option === this.autoPageSizeOption ? $localize`Auto` : `${page_size_option}`;
  }

  getAutoRangeLabel(): string {
    if (!this.file_count) {
      return '0 of 0';
    }

    const loaded_count = this.paged_data?.length ?? 0;
    if (loaded_count === 0) {
      return `0 of ${this.file_count}`;
    }

    return `1 - ${loaded_count} of ${this.file_count}`;
  }

  loadMoreAutoFiles(): void {
    this.getAllFiles(false, true);
  }

  syncAutoLoadObserver(): void {
    this.disconnectAutoLoadObserver();

    if (!this.showAutoLoadAnchor || !this.autoLoadAnchorElement || typeof IntersectionObserver === 'undefined') {
      return;
    }

    this.ngZone.runOutsideAngular(() => {
      this.autoLoadObserver = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) {
          return;
        }

        this.ngZone.run(() => this.loadMoreAutoFiles());
      }, {
        rootMargin: '600px 0px'
      });

      this.autoLoadObserver.observe(this.autoLoadAnchorElement);
    });
  }

  disconnectAutoLoadObserver(): void {
    this.autoLoadObserver?.disconnect();
    this.autoLoadObserver = null;
  }

  pageChangeEvent(event) {
    this.manualPageIndex = event.pageIndex;
    this.pageSize = event.pageSize;
    localStorage.setItem(this.pageSizeStorageKey, '' + this.pageSize);
    this.loading_files = Array(this.pageSize).fill(0);
    this.getAllFiles();
  }

  fileSelectionChanged(event: MatSelectionListChange): void {
    const option = event.options?.[0];
    if (!option) return;
    const adding = option.selected;
    const value = option.value;
    if (adding) {
      this.selected_data.push(value.uid);
      this.selected_data_objs.push(value);
    } else {
      this.selected_data      = this.selected_data.filter(e => e !== value.uid);
      this.selected_data_objs = this.selected_data_objs.filter(e => e.uid !== value.uid);
    }

    this.fileSelectionEmitter.emit({new_selection: this.selected_data, thumbnailURL: this.selected_data_objs[0].thumbnailURL});
  }

  toggleSelectionOrder(): void {
    this.reverse_order = !this.reverse_order;
    localStorage.setItem('default_playlist_order_reversed', '' + this.reverse_order);
  }

  drop(event: CdkDragDrop<string[]>): void {
    if (this.reverse_order) {
      event.previousIndex = this.selected_data.length - 1 - event.previousIndex;
      event.currentIndex = this.selected_data.length - 1 - event.currentIndex;
    }
    moveItemInArray(this.selected_data, event.previousIndex, event.currentIndex);
    moveItemInArray(this.selected_data_objs, event.previousIndex, event.currentIndex);
    this.fileSelectionEmitter.emit({new_selection: this.selected_data, thumbnailURL: this.selected_data_objs[0].thumbnailURL});
  }

  removeSelectedFile(index: number): void {
    if (this.reverse_order) {
      index = this.selected_data.length - 1 - index;
    }
    this.selected_data.splice(index, 1);
    this.selected_data_objs.splice(index, 1);
    this.fileSelectionEmitter.emit({new_selection: this.selected_data, thumbnailURL: this.selected_data_objs[0].thumbnailURL});
  }

  originalOrder = (): number => {
    return 0;
  }

  toggleFavorite(file_obj): void {
    file_obj.favorite = !file_obj.favorite;
    this.postsService.updateFile(file_obj.uid, {favorite: file_obj.favorite}).subscribe(res => {});
  }

  openCreatePlaylistDialog(): void {
    const dialogRef = this.dialog.open(CreatePlaylistComponent, {
      data: {
        create_mode: true
      },
      minWidth: '90vw',
      minHeight: '95vh'
    });
    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.getAllPlaylists();
        this.postsService.openSnackBar($localize`Successfully created playlist!`);
      } else if (result === false) {
        this.postsService.openSnackBar($localize`ERROR: failed to create playlist!`);
      }
    });
  }

  goToPlaylist(info_obj: { file: Playlist; event?: KeyboardEvent | MouseEvent | { ctrlKey?: boolean } }): void {
    const playlist = info_obj.file;
    const open_in_new_tab = !!info_obj.event?.ctrlKey;

    if (!playlist) {
      return;
    }

    if (this.postsService.config['Extra']['download_only_mode']) {
      this.downloadPlaylist(playlist.id, playlist.name);
      return;
    }

    this.navigateToPlaylist(playlist, open_in_new_tab);
  }

  navigateToPlaylist(playlist: Playlist, new_tab: boolean): void {
    localStorage.setItem('player_navigator', this.router.url);
    const routeParams = this.getPlaylistRouteParams(playlist);

    if (!new_tab) {
      this.router.navigate(['/player', routeParams]);
      return;
    }

    const routeURL = this.router.serializeUrl(this.router.createUrlTree(['/player', routeParams]));
    window.open(`/#${routeURL}`);
  }

  getPlaylistRouteParams(playlist: Playlist): Record<string, string> {
    const routeParams: Record<string, string> = {
      playlist_id: playlist.id
    };

    if (playlist.auto) {
      routeParams['auto'] = `${playlist.auto}`;
    }

    return routeParams;
  }

  downloadPlaylist(playlist_id: string, playlist_name: string): void {
    this.downloading_content[playlist_id] = true;
    this.postsService.downloadPlaylistFromServer(playlist_id).subscribe(res => {
      this.downloading_content[playlist_id] = false;
      const blob: Blob = res;
      saveAs(blob, playlist_name + '.zip');
    });
  }

  deletePlaylist(args: { file: Playlist; index: number; }): void {
    const playlist = args.file;
    const playlist_id = playlist.id;
    this.postsService.removePlaylist(playlist_id).subscribe(res => {
      if (res['success']) {
        this.playlistLibraryItems = this.playlistLibraryItems.filter(existing_playlist => existing_playlist.id !== playlist_id);
        this.playlists = this.playlists.filter(existing_playlist => existing_playlist.id !== playlist_id);
        this.postsService.openSnackBar($localize`Playlist successfully removed.`);
      }
      this.getAllPlaylists();
    });
  }

  editPlaylistDialog(args: { playlist: Playlist; }): void {
    const playlist = args.playlist;
    const dialogRef = this.dialog.open(CreatePlaylistComponent, {
      data: {
        playlist_id: playlist.id,
        create_mode: false
      },
      minWidth: '85vw'
    });

    dialogRef.afterClosed().subscribe(() => {
      if (dialogRef.componentInstance.playlist_updated) {
        this.getAllPlaylists();
      }
    });
  }
}
