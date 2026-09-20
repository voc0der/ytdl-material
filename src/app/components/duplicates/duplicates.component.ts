import { Component, OnDestroy, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { filter, take, takeUntil } from 'rxjs/operators';
import { MatTooltip } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatIcon } from '@angular/material/icon';
import { DatabaseFile } from 'api-types';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { DuplicateGroup, DuplicateRemovalMode, PostsService } from 'app/posts.services';
import { PickerComponent, type PickerOption } from '../picker/picker.component';
import { fileThumbnailURL, formatDuration } from 'app/utils/file-display';
import { formatRelativeTime } from 'app/utils/relative-time';
import { AppDatePipe } from 'app/pipes/app-date.pipe';

type DuplicateOrder = 'latest' | 'copies' | 'title';

@Component({
    selector: 'app-duplicates',
    templateUrl: './duplicates.component.html',
    styleUrls: ['./duplicates.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatTooltip, MatProgressSpinner, MatIcon, PickerComponent, AppDatePipe]
})
export class DuplicatesComponent implements OnInit, OnDestroy {
  static readonly PAGE_SIZE = 20;

  readonly orderLabel = $localize`:Duplicates order picker:Order`;
  readonly previousPageLabel = $localize`Previous page`;
  readonly nextPageLabel = $localize`Next page`;
  readonly orderOptions: PickerOption<DuplicateOrder>[] = [
    {value: 'latest', label: $localize`:Duplicates ordered by latest download:Latest download`},
    {value: 'copies', label: $localize`:Duplicates ordered by copy count:Most copies`},
    {value: 'title', label: $localize`:Duplicates ordered by title:Title`}
  ];

  duplicate_groups: DuplicateGroup[] = [];
  duplicates_retrieved = false;
  load_failed = false;
  duplicates_check_interval = 5000;
  interval_id = null;
  removing_duplicate_key: string = null;

  order: DuplicateOrder = 'latest';
  page_index = 0;
  sorted: DuplicateGroup[] = [];
  expanded = new Set<string>();

  private destroy$ = new Subject<void>();

  constructor(public postsService: PostsService, private router: Router, private dialog: MatDialog) { }

  ngOnInit(): void {
    this.postsService.files_changed.pipe(takeUntil(this.destroy$)).subscribe(changed => {
      if (changed) {
        this.getDuplicates();
      }
    });

    if (this.postsService.initialized) {
      this.startRefreshing();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1), takeUntil(this.destroy$))
        .subscribe(() => this.startRefreshing());
    }
  }

  ngOnDestroy(): void {
    if (this.interval_id) {
      clearInterval(this.interval_id);
      this.interval_id = null;
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  private startRefreshing(): void {
    if (!this.postsService.config?.Extra?.file_manager_enabled || !this.postsService.hasPermission('filemanager')) {
      this.router.navigate(['/home']);
      return;
    }

    this.getDuplicates();
    this.interval_id = window.setInterval(() => {
      this.getDuplicates();
    }, this.duplicates_check_interval);
  }

  getDuplicates(): void {
    this.postsService.getDuplicates().subscribe(res => {
      this.duplicate_groups = Array.isArray(res && res.duplicates) ? res.duplicates : [];
      this.duplicates_retrieved = true;
      this.load_failed = false;
      this.resort();
    }, () => {
      // Keep what is on the page: the next refresh is five seconds away, and a blank page in
      // the meantime would look like the duplicates were gone.
      this.duplicates_retrieved = true;
      this.load_failed = this.duplicate_groups.length === 0;
    });
  }

  // ------------------------------------------------------------------------------------------
  // The list

  orderChanged(order: DuplicateOrder): void {
    this.order = order;
    this.page_index = 0;
    this.resort();
  }

  private resort(): void {
    const groups = this.duplicate_groups.slice();
    switch (this.order) {
      case 'copies':
        groups.sort((a, b) => Number(b.duplicate_count || 0) - Number(a.duplicate_count || 0)
          || Number(b.newest_registered || 0) - Number(a.newest_registered || 0));
        break;
      case 'title':
        groups.sort((a, b) => this.getGroupTitle(a).localeCompare(this.getGroupTitle(b)));
        break;
      default:
        groups.sort((a, b) => Number(b.newest_registered || 0) - Number(a.newest_registered || 0));
    }
    this.sorted = groups;
    // The last group on the last page can be cleaned up from under the pager.
    this.page_index = Math.min(this.page_index, Math.max(0, this.page_count - 1));
  }

  get page_count(): number {
    return Math.ceil(this.sorted.length / DuplicatesComponent.PAGE_SIZE);
  }

  get page_groups(): DuplicateGroup[] {
    const start = this.page_index * DuplicatesComponent.PAGE_SIZE;
    return this.sorted.slice(start, start + DuplicatesComponent.PAGE_SIZE);
  }

  get range_start(): number {
    return this.page_index * DuplicatesComponent.PAGE_SIZE + 1;
  }

  get range_end(): number {
    return Math.min(this.sorted.length, (this.page_index + 1) * DuplicatesComponent.PAGE_SIZE);
  }

  goToPage(index: number): void {
    this.page_index = Math.max(0, Math.min(index, this.page_count - 1));
  }

  /** Copies beyond the one that will be kept, across every group. */
  get extra_copy_count(): number {
    return this.duplicate_groups.reduce((total, group) => total + Number(group.duplicate_count || 0), 0);
  }

  isExpanded(group: DuplicateGroup): boolean {
    return this.expanded.has(group.duplicate_key);
  }

  toggleExpanded(group: DuplicateGroup): void {
    if (this.expanded.has(group.duplicate_key)) {
      this.expanded.delete(group.duplicate_key);
    } else {
      this.expanded.add(group.duplicate_key);
    }
  }

  // ------------------------------------------------------------------------------------------
  // What a row shows

  getGroupTitle(group: DuplicateGroup): string {
    return group && group.kept_file && group.kept_file.title ? group.kept_file.title : $localize`Untitled`;
  }

  getGroupSourceID(group: DuplicateGroup): string {
    return group && group.source_id ? group.source_id : 'N/A';
  }

  getGroupTypeLabel(group: DuplicateGroup): string {
    return group && group.isAudio ? $localize`Audio` : $localize`Video`;
  }

  /** The copies, oldest first -- the order the backend keeps and removes them in. */
  copies(group: DuplicateGroup): DatabaseFile[] {
    return Array.isArray(group?.duplicate_files) && group.duplicate_files.length
      ? group.duplicate_files
      : (group?.kept_file ? [group.kept_file] : []);
  }

  oldestCopy(group: DuplicateGroup): DatabaseFile | null {
    return this.copies(group)[0] ?? null;
  }

  newestCopy(group: DuplicateGroup): DatabaseFile | null {
    const copies = this.copies(group);
    return copies[copies.length - 1] ?? null;
  }

  lastDownloadedText(group: DuplicateGroup): string {
    const newest = Number(group?.newest_registered || 0);
    return newest ? formatRelativeTime(newest) : '';
  }

  thumbnailFor(group: DuplicateGroup): string | null {
    return fileThumbnailURL(group?.kept_file, this.postsService.path, this.postsService.isLoggedIn ? this.postsService.token : null);
  }

  durationFor(group: DuplicateGroup): string {
    return formatDuration(group?.kept_file?.duration);
  }

  // ------------------------------------------------------------------------------------------
  // Cleaning up

  private isRemovalMode(value: unknown): value is DuplicateRemovalMode {
    return value === 'newest' || value === 'oldest';
  }

  private downloadedOn(file: DatabaseFile | null): string {
    const registered = Number(file?.registered || 0);
    if (!registered) return '';
    return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium'}).format(new Date(registered));
  }

  openRemoveDuplicatesDialog(group: DuplicateGroup): void {
    if (!group || !group.duplicate_key || this.removing_duplicate_key) return;

    const title = this.getGroupTitle(group);
    const count = group.duplicate_count;
    const oldest = this.downloadedOn(this.oldestCopy(group));
    const newest = this.downloadedOn(this.newestCopy(group));
    const dialog_ref = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Remove duplicates`,
      dialogIcon: 'cleaning_services',
      dialogText: $localize`:Remove duplicates dialog text:Keeps one copy of ${title}:duplicate title: and deletes the other ${count}:duplicate count: from disk.

Remove newest keeps the first download (${oldest}:oldest date:). Remove oldest keeps the latest one (${newest}:newest date:).`,
      submitActions: [
        {text: $localize`:Remove newest duplicates button:Remove newest`, value: 'newest', warnSubmitColor: true},
        {text: $localize`:Remove oldest duplicates button:Remove oldest`, value: 'oldest', warnSubmitColor: true}
      ]
    });

    dialog_ref.afterClosed().subscribe(removal_mode => {
      if (!this.isRemovalMode(removal_mode)) return;

      this.removing_duplicate_key = group.duplicate_key;
      this.postsService.removeDuplicates(group.duplicate_key, removal_mode).subscribe(res => {
        this.removing_duplicate_key = null;
        if (res && res.success) {
          this.postsService.openSnackBar(removal_mode === 'oldest' ? $localize`Oldest duplicates removed.` : $localize`Newest duplicates removed.`);
          this.expanded.delete(group.duplicate_key);
          this.postsService.files_changed.next(true);
          this.getDuplicates();
        } else {
          this.postsService.openSnackBar(removal_mode === 'oldest' ? $localize`Failed to remove oldest duplicates.` : $localize`Failed to remove newest duplicates.`);
        }
      }, () => {
        this.removing_duplicate_key = null;
        this.postsService.openSnackBar(removal_mode === 'oldest' ? $localize`Failed to remove oldest duplicates.` : $localize`Failed to remove newest duplicates.`);
      });
    });
  }
}
