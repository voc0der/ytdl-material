import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatTooltip } from '@angular/material/tooltip';
import { NgxFileDropEntry, NgxFileDropModule } from 'ngx-file-drop';
import { FileType } from 'api-types';
import { Archive } from 'api-types/models/Archive';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { PostsService } from 'app/posts.services';
import { saveBlob } from '../../utils/save-blob';

type ArchiveOrder = 'newest' | 'oldest' | 'title' | 'source';

const PAGE_SIZE = 25;
// What the subscription pickers mean by "not filtered by one" and "not tied to one".
const NO_SUBSCRIPTION = 'none';

/**
 * The archive: what has already been downloaded, which is what subscriptions and the download
 * box check so the same upload is not fetched twice. It is one item per extractor and id, the
 * same pair a yt-dlp archive file holds, so a file of them can be taken in and handed back out.
 */
@Component({
    selector: 'app-archive-viewer',
    templateUrl: './archive-viewer.component.html',
    styleUrls: ['./archive-viewer.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose, MatIcon, MatTooltip, MatProgressSpinner, FormsModule, NgxFileDropModule, PickerComponent, DatePipe]
})
export class ArchiveViewerComponent implements OnInit {
  archives: Archive[] = null;
  archives_retrieved = false;
  // What the filters and the order leave, which is what the pages and Select all are over.
  matching: Archive[] = [];
  selected_uids = new Set<string>();
  page_index = 0;
  page_size = PAGE_SIZE;

  text_filter = '';
  sub_id = NO_SUBSCRIPTION;
  type: FileType | 'both' = 'both';
  order: ArchiveOrder = 'newest';

  // importing
  upload_sub_id = NO_SUBSCRIPTION;
  upload_type: FileType = FileType.VIDEO;
  uploading_archive = false;
  uploaded_archive = false;
  files: NgxFileDropEntry[] = [];

  readonly untitledLabel = $localize`Untitled`;
  readonly searchLabel = $localize`Search the archive`;
  readonly subscriptionLabel = $localize`Subscription`;
  readonly fileTypeLabel = $localize`Type`;
  readonly orderLabel = $localize`Sort`;
  readonly previousPageLabel = $localize`Previous page`;
  readonly nextPageLabel = $localize`Next page`;

  readonly typeFilterOptions: PickerOption[] = [
    { value: 'both', label: $localize`Video and audio` },
    { value: FileType.VIDEO, label: $localize`Video` },
    { value: FileType.AUDIO, label: $localize`Audio` }
  ];

  readonly uploadTypeOptions: PickerOption[] = [
    { value: FileType.VIDEO, label: $localize`Video` },
    { value: FileType.AUDIO, label: $localize`Audio` }
  ];

  readonly orderOptions: PickerOption[] = [
    { value: 'newest', label: $localize`Newest first` },
    { value: 'oldest', label: $localize`Oldest first` },
    { value: 'title', label: $localize`Title` },
    { value: 'source', label: $localize`Source` }
  ];

  constructor(public postsService: PostsService, private dialog: MatDialog) { }

  ngOnInit(): void {
    this.getArchives();
  }

  /**
   * Which subscription's archive to show, or the items that belong to none of them. The
   * server keeps one archive per subscription, so this is a choice between them rather than
   * a way to narrow one list -- "No subscription" is not "all of them".
   */
  get subscriptionPickerOptions(): PickerOption[] {
    return [
      { value: NO_SUBSCRIPTION, label: $localize`No subscription` },
      ...(this.postsService.subscriptions ?? []).map(sub => ({ value: sub.id, label: sub.name }))
    ];
  }

  get pageItems(): Archive[] {
    const start = this.page_index * this.page_size;
    return this.matching.slice(start, start + this.page_size);
  }

  get page_count(): number {
    return Math.max(1, Math.ceil(this.matching.length / this.page_size));
  }

  get range_start(): number {
    return this.matching.length === 0 ? 0 : this.page_index * this.page_size + 1;
  }

  get range_end(): number {
    return Math.min(this.matching.length, (this.page_index + 1) * this.page_size);
  }

  get selected_count(): number {
    return this.selected_uids.size;
  }

  /** Whether everything the filters leave is selected, which is what Select all toggles. */
  get all_selected(): boolean {
    return this.matching.length > 0 && this.matching.every(archive => this.selected_uids.has(archive.uid));
  }

  get filtered(): boolean {
    return this.text_filter.trim() !== '' || this.sub_id !== NO_SUBSCRIPTION || this.type !== 'both';
  }

  typeIcon(archive: Archive): string {
    return archive.type === FileType.AUDIO ? 'audiotrack' : 'movie';
  }

  isSelected(archive: Archive): boolean {
    return this.selected_uids.has(archive.uid);
  }

  toggleSelected(archive: Archive): void {
    if (this.selected_uids.has(archive.uid)) {
      this.selected_uids.delete(archive.uid);
    } else {
      this.selected_uids.add(archive.uid);
    }
  }

  toggleAll(): void {
    if (this.all_selected) {
      this.selected_uids.clear();
      return;
    }
    for (const archive of this.matching) {
      this.selected_uids.add(archive.uid);
    }
  }

  filterChanged(text: string): void {
    this.text_filter = text;
    this.applyFilters();
  }

  orderChanged(order: ArchiveOrder): void {
    this.order = order;
    this.applyFilters();
  }

  typeFilterSelectionChanged(value: FileType | 'both'): void {
    this.type = value;
    this.getArchives();
  }

  subFilterSelectionChanged(value: string): void {
    this.sub_id = value;
    // A subscription is all of one type, so its own type is the only one worth asking for.
    if (this.sub_id !== NO_SUBSCRIPTION) {
      this.type = this.postsService.getSubscriptionByID(this.sub_id)?.['type'] ?? this.type;
    }
    this.getArchives();
  }

  subUploadFilterSelectionChanged(value: string): void {
    this.upload_sub_id = value;
    if (this.upload_sub_id !== NO_SUBSCRIPTION) {
      this.upload_type = this.postsService.getSubscriptionByID(this.upload_sub_id)?.['type'] ?? this.upload_type;
    }
  }

  uploadTypeSelectionChanged(value: FileType): void {
    this.upload_type = value;
  }

  goToPage(page_index: number): void {
    this.page_index = Math.min(Math.max(0, page_index), this.page_count - 1);
  }

  getArchives(): void {
    this.postsService.getArchives(this.type === 'both' ? null : this.type, this.sub_id === NO_SUBSCRIPTION ? null : this.sub_id).subscribe(res => {
      this.archives_retrieved = true;
      if (res?.['archives']) {
        this.archives = res['archives'];
        // Anything no longer listed cannot be removed, so it should not stay selected either.
        const available = new Set(this.archives.map(archive => archive.uid));
        this.selected_uids = new Set([...this.selected_uids].filter(uid => available.has(uid)));
        this.applyFilters();
      }
    }, err => {
      this.archives_retrieved = true;
      console.error(err);
    });
  }

  importArchive(): void {
    if (this.files.length === 0) return;
    this.uploading_archive = true;
    for (const droppedFile of this.files) {
      if (!droppedFile.fileEntry.isFile) continue;
      const fileEntry = droppedFile.fileEntry as FileSystemFileEntry;
      fileEntry.file(async (file: File) => {
        const archive_base64 = await blobToBase64(file);
        this.postsService.importArchive(archive_base64 as string, this.upload_type, this.upload_sub_id === NO_SUBSCRIPTION ? null : this.upload_sub_id).subscribe(res => {
          this.uploading_archive = false;
          if (res['success']) {
            this.uploaded_archive = true;
            this.postsService.openSnackBar($localize`Archive imported.`);
          }
          this.getArchives();
        }, err => {
          console.error(err);
          this.uploading_archive = false;
        });
      });
    }
  }

  downloadArchive(): void {
    this.postsService.downloadArchive(this.type === 'both' ? null : this.type, this.sub_id === NO_SUBSCRIPTION ? null : this.sub_id).subscribe(res => {
      saveBlob(res as Blob, 'archive.txt');
    });
  }

  openDeleteSelectedArchivesDialog(): void {
    const count = this.selected_count;
    if (count === 0) return;

    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Remove from archive`,
      dialogText: count === 1
        ? $localize`This item is removed from your archive, so it can be downloaded again.`
        : $localize`These ${count}:removed archive amount: items are removed from your archive, so they can be downloaded again.`,
      submitText: $localize`Remove`,
      warnSubmitColor: true
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.deleteSelectedArchives();
      }
    });
  }

  deleteSelectedArchives(): void {
    const selected = this.archives.filter(archive => this.selected_uids.has(archive.uid));
    if (selected.length === 0) return;

    this.archives = this.archives.filter(archive => !this.selected_uids.has(archive.uid));
    this.selected_uids.clear();
    this.applyFilters();

    this.postsService.deleteArchiveItems(selected).subscribe(res => {
      if (res['success']) {
        this.postsService.openSnackBar($localize`Removed from your archive.`);
      } else {
        this.postsService.openSnackBar($localize`Couldn't remove those items from your archive.`);
      }
      this.getArchives();
    }, err => {
      console.error(err);
      this.postsService.openSnackBar($localize`Couldn't remove those items from your archive.`);
      this.getArchives();
    });
  }

  dropped(files: NgxFileDropEntry[]): void {
    this.files = files.filter(file => file.fileEntry.isFile);
    this.uploading_archive = false;
    this.uploaded_archive = false;
  }

  clearDroppedFiles(): void {
    this.files = [];
    this.uploading_archive = false;
    this.uploaded_archive = false;
  }

  /** Narrows the archive to what the filters leave, in the order that was asked for. */
  private applyFilters(): void {
    const text = this.text_filter.trim().toLowerCase();
    const matching = (this.archives ?? []).filter(archive => {
      if (!text) return true;
      return [archive.title, archive.id, archive.extractor]
        .some(field => typeof field === 'string' && field.toLowerCase().includes(text));
    });

    const by_text = (left: string, right: string) => (left ?? '').localeCompare(right ?? '', undefined, { sensitivity: 'base' });
    switch (this.order) {
      case 'oldest':
        matching.sort((left, right) => left.timestamp - right.timestamp);
        break;
      case 'title':
        matching.sort((left, right) => by_text(left.title || left.id, right.title || right.id));
        break;
      case 'source':
        matching.sort((left, right) => by_text(left.extractor, right.extractor) || by_text(left.title || left.id, right.title || right.id));
        break;
      default:
        matching.sort((left, right) => right.timestamp - left.timestamp);
    }

    this.matching = matching;
    this.page_index = Math.min(this.page_index, this.page_count - 1);
  }

}

function blobToBase64(blob: Blob) {
  return new Promise((resolve, _) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}
