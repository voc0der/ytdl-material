import { Component, HostListener, OnDestroy, OnInit, ViewChild, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { MatTableDataSource } from '@angular/material/table';
import { MatPaginator } from '@angular/material/paginator';
import { MatSort } from '@angular/material/sort';
import { MatDialog } from '@angular/material/dialog';
import { filter, take } from 'rxjs/operators';
import { ConfirmDialogComponent } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { DuplicateGroup, DuplicateRemovalMode, PostsService } from 'app/posts.services';

@Component({
    selector: 'app-duplicates',
    templateUrl: './duplicates.component.html',
    styleUrls: ['./duplicates.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class DuplicatesComponent implements OnInit, OnDestroy {
  duplicate_groups: DuplicateGroup[] = [];
  duplicates_retrieved = false;
  displayedColumnsBig: string[] = ['newest_registered', 'title', 'type', 'duplicate_count', 'actions'];
  displayedColumnsSmall: string[] = ['title', 'duplicate_count', 'actions'];
  displayedColumns: string[] = this.displayedColumnsBig;
  dataSource = new MatTableDataSource<DuplicateGroup>([]);
  duplicates_check_interval = 5000;
  interval_id = null;
  innerWidth = window.innerWidth;
  removing_duplicate_key: string = null;

  @ViewChild(MatPaginator) paginator: MatPaginator;
  @ViewChild(MatSort) sort: MatSort;

  constructor(public postsService: PostsService, private router: Router, private dialog: MatDialog) { }

  ngOnInit(): void {
    this.recalculateColumns();
    this.dataSource.sortingDataAccessor = (group: DuplicateGroup, sort_header_id: string): string | number => {
      if (!group) return '';
      switch (sort_header_id) {
        case 'newest_registered':
          return Number(group.newest_registered || 0);
        case 'title':
          return (group.kept_file && group.kept_file.title ? group.kept_file.title : '').toLowerCase();
        case 'type':
          return group.isAudio ? 'audio' : 'video';
        case 'duplicate_count':
          return Number(group.duplicate_count || 0);
        default:
          return '';
      }
    };

    this.postsService.files_changed.subscribe(changed => {
      if (changed) {
        this.getDuplicates();
      }
    });

    if (this.postsService.initialized) {
      this.startRefreshing();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => this.startRefreshing());
    }
  }

  ngOnDestroy(): void {
    if (this.interval_id) {
      clearInterval(this.interval_id);
      this.interval_id = null;
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.innerWidth = window.innerWidth;
    this.recalculateColumns();
  }

  private recalculateColumns(): void {
    this.displayedColumns = this.innerWidth < 720 ? this.displayedColumnsSmall : this.displayedColumnsBig;
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
      this.dataSource.data = this.duplicate_groups;
      this.dataSource.paginator = this.paginator;
      this.dataSource.sort = this.sort;
      this.duplicates_retrieved = true;
    }, () => {
      this.duplicate_groups = [];
      this.dataSource.data = [];
      this.duplicates_retrieved = true;
    });
  }

  getGroupTitle(group: DuplicateGroup): string {
    return group && group.kept_file && group.kept_file.title ? group.kept_file.title : $localize`Untitled`;
  }

  getGroupSourceID(group: DuplicateGroup): string {
    return group && group.source_id ? group.source_id : 'N/A';
  }

  getGroupTypeLabel(group: DuplicateGroup): string {
    return group && group.isAudio ? $localize`Audio` : $localize`Video`;
  }

  private isRemovalMode(value: string): value is DuplicateRemovalMode {
    return value === 'newest' || value === 'oldest';
  }

  openRemoveDuplicatesDialog(group: DuplicateGroup): void {
    if (!group || !group.duplicate_key || this.removing_duplicate_key) return;

    const dialog_ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogTitle: $localize`Remove duplicates`,
        dialogText: $localize`This will keep one copy and remove ${group.duplicate_count}:duplicate count: matching download(s) for ${this.getGroupTitle(group)}:duplicate title:. Choose whether to remove the newest downloads or the oldest downloads.`,
        submitActions: [
          {text: $localize`Remove Newest`, value: 'newest', warnSubmitColor: true},
          {text: $localize`Remove Oldest`, value: 'oldest', warnSubmitColor: true}
        ]
      }
    });

    dialog_ref.afterClosed().subscribe(removal_mode => {
      if (!this.isRemovalMode(removal_mode)) return;

      this.removing_duplicate_key = group.duplicate_key;
      this.postsService.removeDuplicates(group.duplicate_key, removal_mode).subscribe(res => {
        this.removing_duplicate_key = null;
        if (res && res.success) {
          this.postsService.openSnackBar(removal_mode === 'oldest' ? $localize`Oldest duplicates removed.` : $localize`Newest duplicates removed.`);
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
