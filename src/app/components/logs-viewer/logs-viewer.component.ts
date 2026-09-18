import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from '../../posts.services';
import { MatDialog } from '@angular/material/dialog';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { CdkCopyToClipboard } from '@angular/cdk/clipboard';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';

@Component({
    selector: 'app-logs-viewer',
    templateUrl: './logs-viewer.component.html',
    styleUrls: ['./logs-viewer.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatProgressSpinner, CdkCopyToClipboard, MatIcon, MatTooltip, PickerComponent]
})
export class LogsViewerComponent implements OnInit {

  logs: { text: string, level: string }[] = null;
  logs_text: string = null;
  requested_lines = 50;
  logs_loading = false;

  readonly linesLabel = $localize`Lines`;
  readonly lineOptions: PickerOption[] = [
    { value: 10, label: '10' },
    { value: 25, label: '25' },
    { value: 50, label: '50' },
    { value: 100, label: '100' },
    { value: 0, label: $localize`All` }
  ];
  constructor(private postsService: PostsService, private dialog: MatDialog) { }

  ngOnInit(): void {
    this.getLogs();
  }

  getLogs() {
  if (!this.logs) { this.logs_loading = true; } // only show loading spinner at the first load
    this.postsService.getLogs(this.requested_lines !== 0 ? this.requested_lines : null).subscribe(res => {
      this.logs_loading = false;
      if (res['logs'] !== null || res['logs'] !== undefined) {
        this.logs_text = res['logs'];
        this.logs = [];
        const logs_arr = res['logs'].split('\n');
        logs_arr.forEach(log_line => {
          let level = 'info';
          if (log_line.includes('ERROR')) {
            level = 'error';
          } else if (log_line.includes('WARN')) {
            level = 'warn';
          } else if (log_line.includes('VERBOSE')) {
            level = 'verbose';
          }
          this.logs.push({
            text: log_line,
            level: level
          })
        });
      } else {
        this.postsService.openSnackBar($localize`Failed to retrieve logs!`);
      }
    }, err => {
      this.logs_loading = false;
      console.error(err);
      this.postsService.openSnackBar($localize`Failed to retrieve logs!`);
    });
  }

  linesChanged(lines: number): void {
    this.requested_lines = lines;
    this.getLogs();
  }

  copiedLogsToClipboard() {
    this.postsService.openSnackBar($localize`Logs copied to clipboard!`);
  }

  clearLogs() {
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: 'Clear logs',
      dialogText: 'Would you like to clear your logs? This will delete all your current logs, permanently.',
      submitText: 'Clear',
      warnSubmitColor: true
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.postsService.clearAllLogs().subscribe(res => {
          if (res['success']) {
            this.logs = [];
            this.logs_text = '';
            this.getLogs();
            this.postsService.openSnackBar($localize`Logs successfully cleared!`);
          } else {
            this.postsService.openSnackBar($localize`Failed to clear logs!`);
          }
        }, err => {
          this.postsService.openSnackBar($localize`Failed to clear logs!`);
        });
      }
    });
  }

}
