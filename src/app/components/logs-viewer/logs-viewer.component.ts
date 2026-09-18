import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from '../../posts.services';
import { MatDialog } from '@angular/material/dialog';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { NgStyle } from '@angular/common';
import { MatMiniFabButton, MatButton } from '@angular/material/button';
import { CdkCopyToClipboard } from '@angular/cdk/clipboard';
import { MatIcon } from '@angular/material/icon';
import { MatFormField } from '@angular/material/input';
import { MatSelect, MatOption } from '@angular/material/select';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'app-logs-viewer',
    templateUrl: './logs-viewer.component.html',
    styleUrls: ['./logs-viewer.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatProgressSpinner, NgStyle, MatMiniFabButton, CdkCopyToClipboard, MatIcon, MatFormField, MatSelect, FormsModule, MatOption, MatButton]
})
export class LogsViewerComponent implements OnInit {

  logs: any = null;
  logs_text: string = null;
  requested_lines = 50;
  logs_loading = false;
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
          let color = 'inherit'
          if (log_line.includes('ERROR')) {
            color = 'red';
          } else if (log_line.includes('WARN')) {
            color = 'yellow';
          } else if (log_line.includes('VERBOSE')) {
            color = 'gray';
          }
          this.logs.push({
            text: log_line,
            color: color
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
