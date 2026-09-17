import { Component, OnInit, Input, Output, EventEmitter, ViewChild, ChangeDetectionStrategy, HostBinding } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { VideoInfoDialogComponent } from 'app/dialogs/video-info-dialog/video-info-dialog.component';
import { MatMenuTrigger, MatMenu, MatMenuItem } from '@angular/material/menu';
import { registerLocaleData, NgClass, DatePipe } from '@angular/common';
import localeGB from '@angular/common/locales/en-GB';
import localeFR from '@angular/common/locales/fr';
import localeES from '@angular/common/locales/es';
import localeDE from '@angular/common/locales/de';
import localeZH from '@angular/common/locales/zh';
import localeNB from '@angular/common/locales/nb';
import { DatabaseFile, Playlist } from 'api-types';
import { MatIcon } from '@angular/material/icon';
import { ContentLoaderModule } from '@ngneat/content-loader';
import { MatIconButton } from '@angular/material/button';
import { MatDivider } from '@angular/material/list';
import { MatCard } from '@angular/material/card';
import { MatRipple } from '@angular/material/core';
import { MatTooltip } from '@angular/material/tooltip';

registerLocaleData(localeGB);
registerLocaleData(localeFR);
registerLocaleData(localeES);
registerLocaleData(localeDE);
registerLocaleData(localeZH);
registerLocaleData(localeNB);

export type FileCardLayout = 'grid' | 'list';

/**
 * In the list layout the thumbnail takes this share of the row and the details share the
 * rest. The thumbnail alone sets the row's height, so a list card's height follows from its
 * width, which is what lets the library size its virtualized rows before they render.
 */
export const LIST_CARD_THUMBNAIL_SHARE = 0.6;
export const LIST_CARD_THUMBNAIL_ASPECT_RATIO = 16 / 9;

export function getListCardHeight(card_width: number): number {
  return Math.ceil(Math.max(0, card_width) * LIST_CARD_THUMBNAIL_SHARE / LIST_CARD_THUMBNAIL_ASPECT_RATIO);
}

@Component({
    selector: 'app-unified-file-card',
    templateUrl: './unified-file-card.component.html',
    styleUrls: ['./unified-file-card.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatIcon, ContentLoaderModule, MatMenuTrigger, MatIconButton, MatMenu, MatMenuItem, MatDivider, MatCard, MatRipple, MatTooltip, NgClass, DatePipe]
})
export class UnifiedFileCardComponent implements OnInit {

  // required info
  file_title = '';
  file_length = '';
  file_thumbnail = '';
  type = null;
  elevated = false;

  // optional vars
  thumbnailBlobURL = null;

  streamURL = null;
  showPreview = false;
  previewHoverTimeout: ReturnType<typeof setTimeout> = null;

  // input/output
  @Input() loading = true;
  @Input() theme = null;
  @Input() file_obj = null;
  @Input() card_size = 'medium';
  @Input() layout: FileCardLayout = 'grid';
  @Input() use_youtubedl_archive = false;
  @Input() is_playlist = false;
  @Input() index: number;
  @Input() locale = null;
  @Input() displayDateProperty = 'registered';
  @Input() baseStreamPath = null;
  @Input() jwtString = null;
  @Input() availablePlaylists = null;
  @Output() goToFile = new EventEmitter<any>();
  @Output() toggleFavorite = new EventEmitter<DatabaseFile>();
  @Output() goToSubscription = new EventEmitter<any>();
  @Output() deleteFile = new EventEmitter<any>();
  @Output() addFileToPlaylist = new EventEmitter<any>();
  @Output() editPlaylist = new EventEmitter<any>();


  @ViewChild(MatMenuTrigger) contextMenu: MatMenuTrigger;
  contextMenuPosition = { x: '0px', y: '0px' };

  readonly listThumbnailWidthPercent = LIST_CARD_THUMBNAIL_SHARE * 100;
  readonly listThumbnailAspectRatio = LIST_CARD_THUMBNAIL_ASPECT_RATIO;

  @HostBinding('class.list-layout')
  get isListLayout(): boolean {
    return this.layout === 'list';
  }

  /*
    Planned sizes:
    small: 150x175
    medium: 200x200
    big: 250x200
  */

  constructor(private dialog: MatDialog) { }

  private get normalizedBaseStreamPath(): string {
    return this.baseStreamPath?.endsWith('/')
      ? this.baseStreamPath.slice(0, -1)
      : this.baseStreamPath;
  }

  get isAudioFile(): boolean {
    return !this.is_playlist && (this.file_obj?.type === 'audio' || !!this.file_obj?.isAudio);
  }

  get displayedDateValue(): string | number | Date | null {
    if (!this.file_obj) {
      return null;
    }

    if (this.displayDateProperty === 'upload_date' && this.hasDisplayableUploadDate()) {
      return this.file_obj.upload_date;
    }

    return this.file_obj.registered ?? null;
  }

  get displayedDateTimezone(): string | undefined {
    return this.displayDateProperty === 'upload_date' && this.hasDisplayableUploadDate()
      ? 'UTC'
      : undefined;
  }

  get displayedDateLocale(): string | undefined {
    return this.locale?.ngID;
  }

  /**
   * A normal playlist carries the uids it holds, so it is counted here. An automatic one
   * has no uids array -- the server counts it and sends the total as file_count.
   */
  get playlistItemCount(): number | null {
    if (!this.is_playlist || !this.file_obj) {
      return null;
    }

    if (Array.isArray(this.file_obj.uids)) {
      return this.file_obj.uids.length;
    }

    return Number.isFinite(this.file_obj.file_count) ? this.file_obj.file_count : null;
  }

  get playlistItemCountLabel(): string | null {
    const item_count = this.playlistItemCount;
    if (item_count === null) {
      return null;
    }

    // A playlist holds audio as readily as video, and carries nothing that says which,
    // so the count stays neutral about what it is counting.
    return item_count === 1
      ? $localize`:Playlist card single item count:1 item`
      : $localize`:Playlist card item count:${item_count}:count: items`;
  }

  /**
   * The count needs a line of its own beneath the title, and a small card has no room for
   * one -- its text block would run up into the thumbnail above it. Where the count does
   * show, the title gives up its second line to it, so the block stays as tall as before.
   */
  get showPlaylistItemCount(): boolean {
    return this.card_size !== 'small' && this.playlistItemCountLabel !== null;
  }

  /**
   * Every playlist can hold every file. The menu used to offer only playlists whose type
   * matched the file's, but a playlist's type is never written -- so the comparison came
   * down to "the file is strictly video", and the menu opened empty for audio and for any
   * older record with no isAudio at all. Nothing else in the app draws that distinction:
   * the create and edit dialog picks from every file regardless of type, and the player
   * types each item as it plays it.
   */
  get playlistsToAddTo(): Playlist[] {
    return Array.isArray(this.availablePlaylists) ? this.availablePlaylists : [];
  }

  playlistContainsFile(playlist: Playlist): boolean {
    return Array.isArray(playlist?.uids) && playlist.uids.includes(this.file_obj?.uid);
  }

  private hasDisplayableUploadDate(): boolean {
    return typeof this.file_obj?.upload_date === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(this.file_obj.upload_date);
  }

  ngOnInit(): void {
    if (!this.loading) {
      this.file_length = fancyTimeFormat(this.file_obj.duration);
    }

    // The endpoint takes the uid of the file the thumbnail belongs to, never its path:
    // a path says nothing about who owns it, and the media folders are shared.
    // A category borrows a thumbnail from one of its files and names that file instead.
    const thumbnailFileUid = this.file_obj?.thumbnailFileUid ?? (this.is_playlist ? null : this.file_obj?.uid);
    if (this.file_obj && this.file_obj.thumbnailPath && thumbnailFileUid) {
      const authQuery = this.jwtString ? `jwt=${this.jwtString}` : '';
      this.thumbnailBlobURL = `${this.normalizedBaseStreamPath}/thumbnail/${encodeURIComponent(thumbnailFileUid)}${authQuery ? '?' + authQuery : ''}`;
    }

  }

  emitDeleteFile(blacklistMode = false) {
    this.deleteFile.emit({
      file: this.file_obj,
      index: this.index,
      blacklistMode: blacklistMode
    });
  }

  emitAddFileToPlaylist(playlist_id) {
    this.addFileToPlaylist.emit({
      file: this.file_obj,
      playlist_id: playlist_id
    });
  }

  navigateToFile(event) {
    this.goToFile.emit({file: this.file_obj, event: event});
  }

  navigateToSubscription() {
    this.goToSubscription.emit(this.file_obj);
  }

  openFileInfoDialog() {
    const dialogRef = this.dialog.open(VideoInfoDialogComponent, {
      data: {
        file: this.file_obj,
      },
      panelClass: 'kit-dialog-panel',
      width: '720px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });

    dialogRef.afterClosed().subscribe(() => {
      this.file_obj = dialogRef.componentInstance.file;
    });
  }

  emitEditPlaylist() {
    this.editPlaylist.emit({
      playlist: this.file_obj,
      index: this.index
    });
  }

  onRightClick(event) {
    event.preventDefault();
    this.contextMenuPosition.x = event.clientX + 'px';
    this.contextMenuPosition.y = event.clientY + 'px';
    this.contextMenu.menuData = { 'item': {id: 1, name: 'hi'} };
    this.contextMenu.menu.focusFirstItem('mouse');
    this.contextMenu.openMenu();
  }

  generateStreamURL() {
    let fullLocation = `${this.normalizedBaseStreamPath}/stream?uid=${encodeURIComponent(this.file_obj['uid'])}`;

    fullLocation += `&type=${this.file_obj.isAudio ? 'audio' : 'video'}`;

    if (this.jwtString) {
      fullLocation += `&jwt=${this.jwtString}`;
    }

    fullLocation += '&t=,10';

    return fullLocation;
  }

  onMouseOver() {
    this.elevated = true;
    if (this.previewHoverTimeout) {
      clearTimeout(this.previewHoverTimeout);
    }
    this.previewHoverTimeout = setTimeout(() => {
      if (this.elevated) {
        if (!this.streamURL && this.file_obj && !this.is_playlist && !(this.file_obj.type === 'audio' || this.file_obj.isAudio)) {
          this.streamURL = this.generateStreamURL();
        }
        this.showPreview = true;
      }
    }, 500);
  }

  onMouseOut() {
    if (this.previewHoverTimeout) {
      clearTimeout(this.previewHoverTimeout);
      this.previewHoverTimeout = null;
    }
    this.elevated = false;
    this.showPreview = false;
  }

  emitToggleFavorite() {
    this.toggleFavorite.emit(this.file_obj);
  }

}

function fancyTimeFormat(time) {
  if (typeof time === 'string') {
    return time;
  }
  // Hours, minutes and seconds
  const hrs = ~~(time / 3600);
  const mins = ~~((time % 3600) / 60);
  const secs = ~~time % 60;

  // Output like "1:01" or "4:03:59" or "123:03:59"
  let ret = '';

  if (hrs > 0) {
      ret += '' + hrs + ':' + (mins < 10 ? '0' : '');
  }

  ret += '' + mins + ':' + (secs < 10 ? '0' : '');
  ret += '' + secs;
  return ret;
}
