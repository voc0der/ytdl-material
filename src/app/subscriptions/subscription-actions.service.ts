import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Subscription } from 'api-types';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialogData, openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { PostsService } from 'app/posts.services';
import { saveBlob } from 'app/utils/save-blob';

/**
 * What can be done to a subscription from its card and from its own page, with the
 * confirmation each destructive action asks for first. Each resolves to whether it happened.
 */
@Injectable({ providedIn: 'root' })
export class SubscriptionActionsService {
  constructor(private postsService: PostsService, private dialog: MatDialog) { }

  /** The subscription's cover: the thumbnail of its newest download that has one. */
  coverURL(sub: Subscription): string | null {
    if (!sub?.thumbnail_file_uid) return null;
    const base = this.postsService.path.endsWith('/') ? this.postsService.path.slice(0, -1) : this.postsService.path;
    const auth = this.postsService.isLoggedIn && this.postsService.token ? `?jwt=${encodeURIComponent(this.postsService.token)}` : '';
    return `${base}/thumbnail/${encodeURIComponent(sub.thumbnail_file_uid)}${auth}`;
  }

  async check(sub: Subscription): Promise<boolean> {
    return this.succeeded(this.postsService.checkSubscription(sub.id), $localize`Couldn't check ${sub.name}:subscription name:.`);
  }

  async cancelCheck(sub: Subscription): Promise<boolean> {
    return this.succeeded(this.postsService.cancelCheckSubscription(sub.id), $localize`Couldn't stop checking ${sub.name}:subscription name:.`);
  }

  async setPaused(sub: Subscription, paused: boolean): Promise<boolean> {
    const done = await this.succeeded(
      this.postsService.updateSubscription({ id: sub.id, paused }),
      paused ? $localize`Couldn't pause ${sub.name}:subscription name:.` : $localize`Couldn't resume ${sub.name}:subscription name:.`
    );
    if (done) {
      this.postsService.reloadSubscriptions();
    }
    return done;
  }

  async unsubscribe(sub: Subscription): Promise<boolean> {
    const file_count = sub.file_count ?? 0;
    const confirmed = await this.confirm({
      dialogTitle: $localize`Unsubscribe from ${sub.name || sub.url}:subscription name:?`,
      dialogText: file_count > 0
        ? $localize`Its ${file_count}:file count: downloaded files are deleted too. This can't be undone.`
        : $localize`It stops checking for new uploads.`,
      submitText: $localize`Unsubscribe`,
      warnSubmitColor: true
    });
    if (!confirmed) return false;

    const done = await this.succeeded(this.postsService.unsubscribe(sub.id, true), $localize`Couldn't unsubscribe from ${sub.name}:subscription name:.`);
    if (done) {
      this.postsService.openSnackBar($localize`Unsubscribed from ${sub.name || sub.url}:subscription name:.`);
      this.postsService.reloadSubscriptions();
      this.postsService.files_changed.next(true);
    }
    return done;
  }

  async redownload(sub: Subscription): Promise<boolean> {
    const confirmed = await this.confirm({
      dialogTitle: $localize`Delete and redownload ${sub.name}:subscription name:`,
      dialogText: $localize`This will delete every downloaded video in ${sub.name}:subscription name: and queue that subscription again using its current settings. Other videos are not affected.`,
      submitText: $localize`Delete and redownload`,
      warnSubmitColor: true
    });
    if (!confirmed) return false;

    try {
      const res = await firstValueFrom(this.postsService.redownloadSubscription(sub.id));
      if (!res?.['success']) {
        const error = res?.['error'] ? ` ${res['error']}` : '';
        this.postsService.openSnackBar($localize`ERROR: Failed to start redownload for ${sub.name}:subscription name:.` + error, 'OK.');
        return false;
      }
    } catch (err) {
      console.error(err);
      this.postsService.openSnackBar($localize`ERROR: Failed to start redownload for ${sub.name}:subscription name:.`, 'OK.');
      return false;
    }

    this.postsService.openSnackBar($localize`Redownload started for ${sub.name}:subscription name:`);
    this.postsService.reloadSubscriptions();
    this.postsService.files_changed.next(true);
    return true;
  }

  async exportArchive(sub: Subscription): Promise<boolean> {
    try {
      const blob = await firstValueFrom(this.postsService.downloadArchive(null, sub.id));
      saveBlob(blob, 'archive.txt');
      return true;
    } catch (err) {
      console.error(err);
      this.postsService.openSnackBar($localize`Couldn't export the archive for ${sub.name}:subscription name:.`);
      return false;
    }
  }

  private async confirm(data: ConfirmDialogData): Promise<boolean> {
    return !!(await firstValueFrom(openConfirmDialog(this.dialog, data).afterClosed()));
  }

  private async succeeded(request: ReturnType<PostsService['checkSubscription']>, failure: string): Promise<boolean> {
    try {
      const res = await firstValueFrom(request);
      if (res?.success) return true;
    } catch (err) {
      console.error(err);
    }
    this.postsService.openSnackBar(failure);
    return false;
  }
}
