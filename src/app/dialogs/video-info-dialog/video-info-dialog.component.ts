import { Component, OnInit, Inject, ChangeDetectionStrategy } from '@angular/core';
import { filesize } from 'filesize';
import { MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { Category, DatabaseFile } from 'api-types';
import { DatePipe, DecimalPipe, KeyValuePipe } from '@angular/common';
import { MatIcon } from '@angular/material/icon';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { MatDatepickerInput, MatDatepickerToggle, MatDatepicker } from '@angular/material/datepicker';
import { MatSelect, MatOption } from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';

@Component({
    selector: 'app-video-info-dialog',
    templateUrl: './video-info-dialog.component.html',
    styleUrls: ['./video-info-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, MatIcon, CdkScrollable, MatDialogContent, FormsModule, MatDatepickerInput, MatDatepickerToggle, MatDatepicker, MatSelect, MatOption, MatDialogActions, MatDialogClose, MatTooltip, KeyValuePipe, DecimalPipe]
})
export class VideoInfoDialogComponent implements OnInit {
  file: DatabaseFile;
  new_file: DatabaseFile;
  filesize;
  audioLabel = $localize`Audio`;
  videoLabel = $localize`Video`;
  upload_date: Date;
  category: Category;
  editing = false;
  initialized = false;
  retrieving_file = false;
  write_access = false;
  // Snipping needs a player to scrub in, so it is only offered when the dialog was opened
  // from one. The player reads snip_requested back off this instance once the dialog closes.
  allow_snip = false;
  snip_requested = false;
  generating_thumbnail = false;
  /*************************************************
   * The timestamp only has a say when the cover art
   * came from a video frame: when the source's own
   * art can be fetched, it is ignored entirely.
   *
   * So the control for it stays hidden until a run
   * actually falls back to a frame, rather than
   * sitting in the action row as a bare number that
   * usually does nothing.
   ************************************************/
  used_frame = false;
  frame_seconds_used: number | null = null;
  thumbnail_timestamp: number | null = null;

  constructor(@Inject(MAT_DIALOG_DATA) public data: any, public postsService: PostsService, private datePipe: DatePipe) { }

  ngOnInit(): void {
    this.filesize = filesize;
    if (this.data) {
      this.allow_snip = !!this.data.allow_snip;
      this.initializeFile(this.data.file);
    }
    this.postsService.reloadCategories();
    if (this.file?.uid) {
      this.getFile();
    }
  }

  initializeFile(file: DatabaseFile): void {
    if (!file) return;
    this.file = file;
    this.new_file = JSON.parse(JSON.stringify(file));

    // use UTC for the date picker. not the cleanest approach but it allows it to match the upload date
    this.upload_date = new Date(this.new_file.upload_date);
    this.upload_date.setMinutes( this.upload_date.getMinutes() + this.upload_date.getTimezoneOffset() );

    this.category = this.file.category ? this.file.category : {};
    this.write_access = !this.file?.user_uid || (this.file?.user_uid && this.postsService.user?.uid === this.file.user_uid);

    // we need to align whether missing category is null or undefined. this line helps with that.
    if (!this.file.category) { this.new_file.category = null; this.file.category = null; }
    this.initialized = true;
  }

  saveChanges(): void {
    if (!this.write_access || this.retrieving_file) return;
    const change_obj = {};
    const keys = Object.keys(this.new_file);
    keys.forEach(key => {
      if (this.file[key] !== this.new_file[key]) change_obj[key] = this.new_file[key];
    });

    this.retrieving_file = true;
    this.postsService.updateFile(this.file.uid, change_obj).subscribe(res => {
      this.editing = false;
      this.getFile();
    }, err => {
      this.retrieving_file = false;
      console.error(err);
      this.postsService.openSnackBar($localize`Could not save changes. Please try again.`);
    });
  }

  cancelEditing(): void {
    this.initializeFile(this.file);
    this.editing = false;
  }

  formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
  }

  getFile(): void {
    this.retrieving_file = true;
    this.postsService.getFile(this.file.uid).subscribe(res => {
      this.retrieving_file = false;
      this.file = res['file'];
      this.initializeFile(this.file);
    }, err => {
      this.retrieving_file = false;
      console.error(err);
    });
  }

  uploadDateChanged(event): void {
    this.new_file.upload_date = this.datePipe.transform(event.value, 'yyyy-MM-dd');
  }

  categoryChanged(event): void {
    const new_category = event.value;
    this.new_file.category = Object.keys(new_category).length ? {uid: new_category.uid, name: new_category.name} : null;
  }

  categoryComparisonFunction(option: Category, value: Category): boolean {
    // can't access properties of null/undefined values, prehandle these
    if (!option && !value) return true;
    else if (!option || !value) return false;

    return option.uid === value.uid;
  }

  metadataChanged(): boolean {
    return JSON.stringify(this.file) !== JSON.stringify(this.new_file);
  }

  canSnip(): boolean {
    return this.allow_snip && this.initialized && this.write_access && this.postsService.hasPermission('filemanager');
  }

  requestSnip(): void {
    this.snip_requested = true;
  }

  canGenerateThumbnail(): boolean {
    return this.initialized && this.write_access && this.postsService.hasPermission('filemanager');
  }

  hasThumbnail(): boolean {
    return !!this.file?.thumbnailPath;
  }

  generateThumbnail(): void {
    // A blank box means "use the default": Number(null) and Number('') are both 0, so an
    // empty box would otherwise ask for the very first frame, which is usually black.
    const raw = this.thumbnail_timestamp;
    const provided = raw !== null && raw !== undefined && String(raw) !== '';
    const timestamp = provided ? Number(raw) : NaN;
    this.generating_thumbnail = true;
    this.postsService.generateThumbnail(this.file.uid, Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null).subscribe(res => {
      this.generating_thumbnail = false;
      if (!res?.['success']) {
        this.postsService.openSnackBar($localize`Could not generate cover art for this file.`);
        return;
      }

      this.used_frame = res['method'] === 'frame';
      if (this.used_frame) {
        // Seed the box with what was actually used, so changing it is an adjustment rather
        // than a guess from nothing.
        this.frame_seconds_used = res['seek_seconds'] ?? null;
        if (this.thumbnail_timestamp === null) this.thumbnail_timestamp = this.frame_seconds_used;
        this.postsService.openSnackBar($localize`Cover art taken from the video.`);
      } else {
        this.frame_seconds_used = null;
        this.postsService.openSnackBar($localize`Cover art fetched from the original.`);
      }

      // The card behind the dialog reads its image off the record, so pull the new one.
      this.getFile();
    }, err => {
      this.generating_thumbnail = false;
      console.error(err);
      this.postsService.openSnackBar($localize`Could not generate cover art for this file.`);
    });
  }

  toggleFavorite(): void {
    // Keep unsaved edits intact when the favorite action refreshes its own state.
    const favorite = !this.file.favorite;
    this.retrieving_file = true;
    this.postsService.updateFile(this.file.uid, {favorite}).subscribe(res => {
      this.file.favorite = favorite;
      this.new_file.favorite = favorite;
      this.retrieving_file = false;
    }, err => {
      this.retrieving_file = false;
      console.error(err);
      this.postsService.openSnackBar($localize`Could not update favorite. Please try again.`);
    });
  }

  getSubtitleSummary(): string {
    const subtitles = this.new_file?.subtitles;
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      return $localize`None detected`;
    }

    return subtitles.map((subtitle, index) => {
      const label = typeof subtitle?.label === 'string' && subtitle.label.trim() !== ''
        ? subtitle.label.trim()
        : (typeof subtitle?.language === 'string' && subtitle.language.trim() !== ''
          ? subtitle.language.trim()
          : `Track ${index + 1}`);
      return subtitle?.default ? `${label} (${ $localize`default` })` : label;
    }).join(', ');
  }

}
