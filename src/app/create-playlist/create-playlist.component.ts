import { ChangeDetectionStrategy, Component, ElementRef, Inject, OnInit, QueryList, ViewChildren } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDragPlaceholder, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatTooltip } from '@angular/material/tooltip';
import { DatabaseFile, FileTypeFilter, Playlist, Subscription } from 'api-types';
import { PostsService } from 'app/posts.services';
import { PickerComponent, type PickerOption } from 'app/components/picker/picker.component';
import { durationSeconds, fileThumbnailURL, formatDuration } from 'app/utils/file-display';

export interface PlaylistDialogData {
  create_mode?: boolean;
  playlist_id?: string;
}

type PlaylistDialogView = 'library' | 'playlist';

/**
 * Opens the playlist editor with the surface the other dialogs share. It closes with true once
 * a playlist was created or saved, and says so itself, so a caller only has to refresh.
 *
 * The height is fixed rather than following the content: the editor switches between the whole
 * library and the few files picked from it, and a dialog that grew and shrank with each would
 * move its own tabs out from under the pointer.
 */
export function openPlaylistDialog(dialog: MatDialog, data: PlaylistDialogData): MatDialogRef<CreatePlaylistComponent, boolean> {
  return dialog.open(CreatePlaylistComponent, {
    data,
    panelClass: 'kit-dialog-panel',
    width: '720px',
    height: '760px',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100dvh - 32px)',
    autoFocus: 'dialog'
  });
}

/**
 * Creates a playlist, or edits one: its name, which files are in it, and the order they play in.
 *
 * The file picker is this dialog's own rather than the media library's. The library opens this
 * dialog, so the dialog embedding the library made the two import each other, and a production
 * build could evaluate this one first -- with the library still undefined in its imports, which
 * Angular reports as NG0919 and renders as an empty dialog.
 */
@Component({
    selector: 'app-create-playlist',
    templateUrl: './create-playlist.component.html',
    styleUrls: ['./create-playlist.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, MatDialogClose, CdkScrollable, MatDialogContent, MatDialogActions, FormsModule, MatIcon,
      MatProgressSpinner, MatTooltip, PickerComponent, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder, DatePipe, NgTemplateOutlet]
})
export class CreatePlaylistComponent implements OnInit {
  // A library can hold thousands of files. Rows are cheap, but not that cheap, so the list
  // grows by this many at a time.
  static readonly PAGE_SIZE = 100;

  readonly create_mode: boolean;
  readonly playlist_id: string | null;

  readonly sourceLabel = $localize`:Playlist source filter label:Download source`;
  readonly searchLabel = $localize`:Search playlist candidates:Search files`;
  readonly removeLabel = $localize`:Remove file from playlist:Remove from playlist`;
  readonly moveLabel = $localize`:Reorder playlist item hint:Drag to reorder, or use the arrow keys`;

  name = '';
  playlist: Playlist | null = null;
  playlist_failed = false;
  saving = false;
  view: PlaylistDialogView;

  // The library the files are picked from.
  files: DatabaseFile[] = [];
  files_received = false;
  files_failed = false;
  search_text = '';
  source: string | null = null;
  sources: Subscription[] = [];
  sourceOptions: PickerOption[] = [];
  matching: DatabaseFile[] = [];
  shown: DatabaseFile[] = [];
  matching_selected_count = 0;
  private shown_limit = CreatePlaylistComponent.PAGE_SIZE;
  private file_request_id = 0;

  // The playlist, in the order it plays.
  selected: DatabaseFile[] = [];
  private selected_uids = new Set<string>();

  @ViewChildren('orderHandle') orderHandles: QueryList<ElementRef<HTMLButtonElement>>;

  constructor(@Inject(MAT_DIALOG_DATA) public data: PlaylistDialogData,
              public postsService: PostsService,
              public dialogRef: MatDialogRef<CreatePlaylistComponent, boolean>) {
    this.create_mode = !!data?.create_mode;
    this.playlist_id = data?.playlist_id ?? null;
    // Creating starts from the library, since there is nothing to order yet. Editing starts
    // from what is already in the playlist.
    this.view = this.create_mode ? 'library' : 'playlist';
    this.sourceOptions = this.buildSourceOptions();
  }

  ngOnInit(): void {
    if (!this.create_mode && this.playlist_id) this.getPlaylist();
    this.getFiles();
    this.getSources();
  }

  // ------------------------------------------------------------------------------------------
  // Loading

  getPlaylist(): void {
    this.playlist_failed = false;
    this.postsService.getPlaylist(this.playlist_id, null, true).subscribe(res => {
      if (!res?.playlist) {
        this.playlist_failed = true;
        return;
      }
      this.playlist = res.playlist;
      this.name = res.playlist.name ?? '';
      this.setSelection(res.file_objs ?? []);
    }, () => {
      this.playlist_failed = true;
    });
  }

  /**
   * The whole library, or one subscription's part of it, newest first. The library's own
   * filters are ignored: they are not shown here, so a remembered "audio only" would hide files
   * with nothing on screen to say why.
   */
  getFiles(): void {
    const request_id = ++this.file_request_id;
    this.files_received = false;
    this.files_failed = false;
    this.postsService.getAllFiles({by: 'registered', order: -1}, null, null, FileTypeFilter.BOTH, false, this.source, false, [])
      .subscribe(res => {
        // A source picked while this was on its way has a newer request out already.
        if (request_id !== this.file_request_id) return;
        this.files = res?.files ?? [];
        this.files_received = true;
        this.refilter();
      }, () => {
        if (request_id !== this.file_request_id) return;
        this.files = [];
        this.files_received = true;
        this.files_failed = true;
        this.refilter();
      });
  }

  getSources(): void {
    this.postsService.getAllSubscriptions().subscribe(res => {
      this.sources = res?.subscriptions ?? [];
      this.sourceOptions = this.buildSourceOptions();
    }, () => {
      this.sources = [];
    });
  }

  private buildSourceOptions(): PickerOption[] {
    return [
      {value: null, label: $localize`:All download sources option:All files`},
      ...this.sources.map(subscription => ({value: subscription.id, label: subscription.name}))
    ];
  }

  sourceChanged(sub_id: string | null): void {
    if (sub_id === this.source) return;
    this.source = sub_id || null;
    this.files = [];
    this.refilter();
    this.getFiles();
  }

  // ------------------------------------------------------------------------------------------
  // The library list

  searchChanged(text: string): void {
    this.search_text = text;
    this.shown_limit = CreatePlaylistComponent.PAGE_SIZE;
    this.refilter();
  }

  /** Recomputed when something it depends on changes, not on every check: the list can be long. */
  private refilter(): void {
    const query = this.search_text.trim().toLowerCase();
    this.matching = query
      ? this.files.filter(file => `${file.title ?? ''} ${file.uploader ?? ''}`.toLowerCase().includes(query))
      : this.files;
    this.shown = this.matching.slice(0, this.shown_limit);
    this.recount();
  }

  private recount(): void {
    this.matching_selected_count = this.matching.reduce((count, file) => count + (this.selected_uids.has(file.uid) ? 1 : 0), 0);
  }

  get hidden_count(): number {
    return this.matching.length - this.shown.length;
  }

  showMore(): void {
    this.shown_limit += CreatePlaylistComponent.PAGE_SIZE;
    this.shown = this.matching.slice(0, this.shown_limit);
  }

  get all_matching_selected(): boolean {
    return this.matching.length > 0 && this.matching_selected_count === this.matching.length;
  }

  isSelected(file: DatabaseFile): boolean {
    return this.selected_uids.has(file.uid);
  }

  toggle(file: DatabaseFile): void {
    if (this.isSelected(file)) {
      this.selected = this.selected.filter(selected => selected.uid !== file.uid);
      this.selected_uids.delete(file.uid);
    } else {
      this.selected = [...this.selected, file];
      this.selected_uids.add(file.uid);
    }
    this.recount();
  }

  /** Adds every file the search matches, in the order listed, or takes them all back out. */
  toggleAllMatching(): void {
    if (this.all_matching_selected) {
      const matching_uids = new Set(this.matching.map(file => file.uid));
      this.setSelection(this.selected.filter(file => !matching_uids.has(file.uid)));
      return;
    }
    const added = this.matching.filter(file => !this.selected_uids.has(file.uid));
    this.setSelection([...this.selected, ...added]);
  }

  // ------------------------------------------------------------------------------------------
  // The playlist

  private setSelection(files: DatabaseFile[]): void {
    const seen = new Set<string>();
    this.selected = files.filter(file => file?.uid && !seen.has(file.uid) && seen.add(file.uid));
    this.selected_uids = seen;
    this.recount();
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  remove(index: number): void {
    this.setSelection(this.selected.filter((_, i) => i !== index));
  }

  reverse(): void {
    this.selected = this.selected.slice().reverse();
  }

  drop(event: CdkDragDrop<DatabaseFile[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    const reordered = this.selected.slice();
    moveItemInArray(reordered, event.previousIndex, event.currentIndex);
    this.selected = reordered;
  }

  /** The keyboard's way to drag: arrow keys on a row's handle move it, and focus goes with it. */
  move(index: number, delta: number, event?: Event): void {
    event?.preventDefault();
    const target = index + delta;
    if (target < 0 || target >= this.selected.length) return;
    const reordered = this.selected.slice();
    moveItemInArray(reordered, index, target);
    this.selected = reordered;
    setTimeout(() => this.orderHandles?.get(target)?.nativeElement.focus());
  }

  get total_duration(): string {
    return formatDuration(this.selected.reduce((total, file) => total + durationSeconds(file.duration), 0));
  }

  // ------------------------------------------------------------------------------------------
  // Saving

  get changed(): boolean {
    if (this.create_mode) return true;
    if (!this.playlist) return false;
    const uids = this.selected.map(file => file.uid);
    return this.name.trim() !== this.playlist.name
      || uids.length !== this.playlist.uids.length
      || uids.some((uid, index) => uid !== this.playlist.uids[index]);
  }

  get can_save(): boolean {
    return !this.saving && !!this.name.trim() && this.selected.length > 0 && this.changed;
  }

  save(): void {
    if (!this.can_save) return;
    if (this.create_mode) {
      this.createPlaylist();
    } else {
      this.updatePlaylist();
    }
  }

  private createPlaylist(): void {
    this.saving = true;
    // A playlist is shown with the thumbnail of what plays first.
    const thumbnail_url = this.selected[0]?.thumbnailURL ?? null;
    this.postsService.createPlaylist(this.name.trim(), this.selected.map(file => file.uid), thumbnail_url).subscribe(res => {
      this.saving = false;
      if (res?.success) {
        this.postsService.openSnackBar($localize`Successfully created playlist!`);
        this.postsService.playlists_changed.next(true);
        this.dialogRef.close(true);
      } else {
        this.postsService.openSnackBar($localize`ERROR: failed to create playlist!`);
      }
    }, () => {
      this.saving = false;
      this.postsService.openSnackBar($localize`ERROR: failed to create playlist!`);
    });
  }

  private updatePlaylist(): void {
    this.saving = true;
    const updated: Playlist = {...this.playlist, name: this.name.trim(), uids: this.selected.map(file => file.uid)};
    this.postsService.updatePlaylist(updated).subscribe(res => {
      this.saving = false;
      if (res?.success) {
        this.playlist = updated;
        this.postsService.openSnackBar($localize`Playlist updated successfully.`);
        this.postsService.playlists_changed.next(true);
        this.dialogRef.close(true);
      } else {
        this.postsService.openSnackBar($localize`:Playlist update failed:Failed to update playlist.`);
      }
    }, () => {
      this.saving = false;
      this.postsService.openSnackBar($localize`:Playlist update failed:Failed to update playlist.`);
    });
  }

  // ------------------------------------------------------------------------------------------
  // What a row shows

  thumbnailFor(file: DatabaseFile): string | null {
    return fileThumbnailURL(file, this.postsService.path, this.postsService.isLoggedIn ? this.postsService.token : null);
  }

  durationFor(file: DatabaseFile): string {
    return formatDuration(file.duration);
  }
}
