import { Component, OnInit, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SubscribeDialogComponent } from 'app/dialogs/subscribe-dialog/subscribe-dialog.component';
import { PostsService } from 'app/posts.services';
import { Router } from '@angular/router';
import { SubscriptionInfoDialogComponent } from 'app/dialogs/subscription-info-dialog/subscription-info-dialog.component';
import { EditSubscriptionDialogComponent } from 'app/dialogs/edit-subscription-dialog/edit-subscription-dialog.component';
import { ConfirmDialogComponent } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { Subscription } from 'api-types';

@Component({
    selector: 'app-subscriptions',
    templateUrl: './subscriptions.component.html',
    styleUrls: ['./subscriptions.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class SubscriptionsComponent implements OnInit {

  playlist_subscriptions: Subscription[] = [];
  channel_subscriptions: Subscription[] = [];
  subscriptions: Subscription[] = null;
  redownloading_subscriptions: {[sub_id: string]: boolean} = {};

  subscriptions_loading = false;

  constructor(private dialog: MatDialog, public postsService: PostsService, private router: Router, private snackBar: MatSnackBar) { }

  ngOnInit() {
    if (this.postsService.initialized) {
      this.getSubscriptions();
    }
    this.postsService.service_initialized.subscribe(init => {
      if (init) {
        this.getSubscriptions();
      }
    });
  }

  getSubscriptions(show_loading = true) {
    if (show_loading) this.subscriptions_loading = true;
    this.subscriptions = null;
    this.postsService.getAllSubscriptions().subscribe(res => {
      this.channel_subscriptions = [];
      this.playlist_subscriptions = [];
      this.subscriptions_loading = false;
      this.subscriptions = res['subscriptions'];
      if (!this.subscriptions) {
        // set it to an empty array so it can notify the user there are no subscriptions
        this.subscriptions = [];
        return;
      }

      for (let i = 0; i < this.subscriptions.length; i++) {
        const sub = this.subscriptions[i];

        // parse subscriptions into channels and playlists
        if (sub.isPlaylist) {
          this.playlist_subscriptions.push(sub);
        } else {
          this.channel_subscriptions.push(sub);
        }
      }
    }, err => {
      this.subscriptions_loading = false;
      console.error('Failed to get subscriptions');
      this.openSnackBar('ERROR: Failed to get subscriptions!', 'OK.');
    });
  }

  goToSubscription(sub) {
    this.router.navigate(['/subscription', {id: sub.id}]);
  }

  openSubscribeDialog() {
    const dialogRef = this.dialog.open(SubscribeDialogComponent, {
      maxWidth: 500,
      width: '80vw'
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        if (result.isPlaylist) {
          this.playlist_subscriptions.push(result);
        } else {
          this.channel_subscriptions.push(result);
        }
        this.postsService.reloadSubscriptions();
      }
    });
  }

  showSubInfo(sub) {
    const unsubbedEmitter = new EventEmitter<any>();
    const dialogRef = this.dialog.open(SubscriptionInfoDialogComponent, {
      data: {
        sub: sub,
        unsubbedEmitter: unsubbedEmitter
      }
    });
    unsubbedEmitter.subscribe(success => {
      if (success) {
        this.openSnackBar(`${sub.name} successfully deleted!`)
        this.getSubscriptions();
        this.postsService.reloadSubscriptions();
      }
    })
  }

  editSubscription(sub) {
    const dialogRef = this.dialog.open(EditSubscriptionDialogComponent, {
      data: {
        sub: this.postsService.getSubscriptionByID(sub.id)
      }
    });
    dialogRef.afterClosed().subscribe(() => {
      this.getSubscriptions(false);
    });
  }

  isRedownloadDisabled(sub: Subscription): boolean {
    return !sub?.name || !!this.redownloading_subscriptions[sub.id];
  }

  confirmRedownloadSubscription(sub: Subscription): void {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogTitle: $localize`Delete and redownload ${sub.name}:subscription name:`,
        dialogText: $localize`This will delete every downloaded video in ${sub.name}:subscription name: and queue that subscription again using its current settings. Other videos are not affected.`,
        submitText: $localize`Delete and redownload`,
        warnSubmitColor: true
      }
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.redownloadSubscription(sub);
      }
    });
  }

  redownloadSubscription(sub: Subscription): void {
    if (this.isRedownloadDisabled(sub)) return;

    this.redownloading_subscriptions[sub.id] = true;
    this.postsService.redownloadSubscription(sub.id).subscribe(res => {
      this.redownloading_subscriptions[sub.id] = false;
      if (res['success']) {
        this.openSnackBar($localize`Redownload started for ${sub.name}:subscription name:`);
        this.getSubscriptions(false);
        this.postsService.reloadSubscriptions();
        this.postsService.files_changed.next(true);
      } else {
        const error = res['error'] ? ` ${res['error']}` : '';
        this.openSnackBar($localize`ERROR: Failed to start redownload for ${sub.name}:subscription name:.` + error, 'OK.');
      }
    }, err => {
      console.error(err);
      this.redownloading_subscriptions[sub.id] = false;
      this.openSnackBar($localize`ERROR: Failed to start redownload for ${sub.name}:subscription name:.`, 'OK.');
    });
  }

  // snackbar helper
  public openSnackBar(message: string, action = '') {
    this.snackBar.open(message, action, {
      duration: 2000,
    });
  }

}
