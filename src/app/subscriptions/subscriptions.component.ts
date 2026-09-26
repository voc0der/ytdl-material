import { ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuContent, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatDivider } from '@angular/material/divider';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'api-types';
import { firstValueFrom, Subscription as RxSubscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { PostsService } from 'app/posts.services';
import { SubscriptionSettingsComponent } from 'app/components/subscription-settings/subscription-settings.component';
import {
  SubscriptionSettings, SubscriptionState, defaultSubscriptionSettings, formatRelativeTime, isSubscriptionBusy, isSubscriptionChecking,
  lastCheckedAt, subscriptionState
} from 'app/components/subscription-settings/subscription-settings';
import { SubscriptionActionsService } from './subscription-actions.service';

type SubscriptionFilter = 'all' | 'channels' | 'playlists';

// While something is being checked or downloaded its card is kept current. Nothing else
// changes on this page by itself, so an idle list is not polled at all -- and each poll asks
// the backend to count files and downloads for every subscription.
const BUSY_POLL_INTERVAL_MS = 5000;

@Component({
  selector: 'app-subscriptions',
  templateUrl: './subscriptions.component.html',
  styleUrls: ['./subscriptions.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FormsModule, MatIcon, MatMenu, MatMenuContent, MatMenuItem, MatMenuTrigger, MatDivider, MatProgressSpinner, RouterLink,
    SubscriptionSettingsComponent]
})
export class SubscriptionsComponent implements OnInit, OnDestroy {
  subscriptions: Subscription[] | null = null;
  loadFailed = false;
  filter: SubscriptionFilter = 'all';

  // the subscribe form
  url = '';
  name = '';
  settings: SubscriptionSettings = defaultSubscriptionSettings();
  optionsOpen = false;
  subscribing = false;
  subscribeError: string | null = null;

  readonly urlLabel = $localize`Channel or playlist link`;
  readonly optionsLabel = $localize`More subscription options`;
  readonly moreActionsLabel = $localize`More actions`;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private initSubscription: RxSubscription | null = null;
  private destroyed = false;

  constructor(
    public postsService: PostsService,
    private actions: SubscriptionActionsService,
    private router: Router
  ) { }

  ngOnInit(): void {
    this.initSubscription = this.postsService.service_initialized
      .pipe(filter(Boolean), take(1))
      .subscribe(() => this.loadSubscriptions());
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.initSubscription?.unsubscribe();
    this.clearPoll();
  }

  get channelCount(): number {
    return (this.subscriptions ?? []).filter(sub => !sub.isPlaylist).length;
  }

  get playlistCount(): number {
    return (this.subscriptions ?? []).filter(sub => sub.isPlaylist).length;
  }

  // Read the way the backend reads it when subscribing.
  get urlIsPlaylist(): boolean {
    return this.url.includes('playlist');
  }

  get visibleSubscriptions(): Subscription[] {
    const subscriptions = this.subscriptions ?? [];
    if (this.filter === 'channels') return subscriptions.filter(sub => !sub.isPlaylist);
    if (this.filter === 'playlists') return subscriptions.filter(sub => sub.isPlaylist);
    return subscriptions;
  }

  // Options that differ from a plain subscription, so the Options chip can show they are set.
  get hasCustomOptions(): boolean {
    const defaults = defaultSubscriptionSettings();
    return !!this.name.trim()
      || this.settings.use_subfolder !== defaults.use_subfolder
      || this.settings.auto_create_playlist !== defaults.auto_create_playlist
      || (this.settings.retrieve_channel_playlists !== defaults.retrieve_channel_playlists && !this.urlIsPlaylist)
      || !!this.settings.custom_args.trim()
      || !!this.settings.custom_output.trim();
  }

  async loadSubscriptions(): Promise<void> {
    this.clearPoll();
    try {
      const res = await firstValueFrom(this.postsService.getAllSubscriptions());
      if (this.destroyed) return;
      this.subscriptions = this.sortSubscriptions(res?.subscriptions ?? []);
      this.loadFailed = false;
    } catch (err) {
      if (this.destroyed) return;
      console.error(err);
      this.loadFailed = true;
      this.subscriptions = this.subscriptions ?? [];
    }

    // Loads can overlap, as when an action finishes during a poll; only the last one waits.
    this.clearPoll();
    if (this.subscriptions.some(sub => isSubscriptionBusy(sub))) {
      this.pollTimer = setTimeout(() => this.loadSubscriptions(), BUSY_POLL_INTERVAL_MS);
    }
  }

  async subscribe(event?: Event): Promise<void> {
    event?.preventDefault();
    const url = this.url.trim();
    if (!url || this.subscribing) return;

    this.subscribing = true;
    this.subscribeError = null;
    try {
      const res = await firstValueFrom(this.postsService.createSubscription(
        url,
        this.name.trim() || null,
        this.settings.timerange,
        this.settings.maxQuality,
        this.settings.audioOnly,
        this.settings.custom_args.trim(),
        this.settings.custom_output.trim(),
        this.settings.use_subfolder,
        this.settings.auto_create_playlist,
        this.settings.retrieve_channel_playlists && !this.urlIsPlaylist
      ));
      if (res?.new_sub) {
        this.postsService.openSnackBar($localize`Subscribed to ${res.new_sub.name || url}:subscription name:. Its uploads are on the way.`);
        this.resetForm();
      } else {
        this.subscribeError = res?.['error'] || $localize`Couldn't read that link. Check that it points to a channel or a playlist.`;
      }
    } catch (err) {
      console.error(err);
      this.subscribeError = err?.error?.error || $localize`Couldn't subscribe. Try again in a moment.`;
    } finally {
      this.subscribing = false;
    }

    // A link that could not be read is still saved, without a name, so it can be removed.
    this.postsService.reloadSubscriptions();
    await this.loadSubscriptions();
  }

  cancelSubscribe(): void {
    this.resetForm();
  }

  openSettings(sub: Subscription): void {
    this.router.navigate(['/subscription', { id: sub.id, settings: true }]);
  }

  watch(sub: Subscription): void {
    this.router.navigate(['/player', { sub_id: sub.id }]);
  }

  async check(sub: Subscription): Promise<void> {
    if (await this.actions.check(sub)) await this.loadSubscriptions();
  }

  async cancelCheck(sub: Subscription): Promise<void> {
    if (await this.actions.cancelCheck(sub)) await this.loadSubscriptions();
  }

  async setPaused(sub: Subscription, paused: boolean): Promise<void> {
    if (await this.actions.setPaused(sub, paused)) await this.loadSubscriptions();
  }

  async redownload(sub: Subscription): Promise<void> {
    if (await this.actions.redownload(sub)) await this.loadSubscriptions();
  }

  async unsubscribe(sub: Subscription): Promise<void> {
    if (await this.actions.unsubscribe(sub)) await this.loadSubscriptions();
  }

  // A card previews what was downloaded, so the newest thumbnail comes first, and the channel's
  // or playlist's own image stands in until there is one.
  coverURL(sub: Subscription): string | null {
    return this.actions.coverURL(sub) || this.actions.artworkURL(sub);
  }

  coverIsAvatar(sub: Subscription): boolean {
    return !sub.isPlaylist && !this.actions.coverURL(sub) && !!this.actions.artworkURL(sub);
  }

  initial(sub: Subscription): string {
    return (sub.name || '?').trim().charAt(0).toUpperCase();
  }

  state(sub: Subscription): SubscriptionState {
    return subscriptionState(sub);
  }

  isBusy(sub: Subscription): boolean {
    return isSubscriptionBusy(sub);
  }

  isChecking(sub: Subscription): boolean {
    return isSubscriptionChecking(sub);
  }

  // What the card says about where the subscription is.
  statusText(sub: Subscription): string {
    switch (subscriptionState(sub)) {
    case 'unavailable':
      return $localize`Couldn't read this link`;
    case 'paused':
      return $localize`Paused`;
    case 'checking':
      return $localize`Checking for new uploads`;
    case 'downloading': {
      const waiting = (sub.refresh_status?.pending_download_count ?? 0);
      return $localize`Downloading ${waiting}:download count: new`;
    }
    case 'failed':
      return $localize`Last check didn't finish`;
    default: {
      const checked_at = lastCheckedAt(sub);
      return checked_at
        ? $localize`Checked ${formatRelativeTime(checked_at)}:relative time:`
        : $localize`Not checked yet`;
    }
    }
  }

  private resetForm(): void {
    this.url = '';
    this.name = '';
    this.settings = defaultSubscriptionSettings();
    this.optionsOpen = false;
    this.subscribeError = null;
  }

  // Alphabetical, the order a person looks one up in.
  private sortSubscriptions(subscriptions: Subscription[]): Subscription[] {
    return [...subscriptions].sort((a, b) => (a.name || a.url || '').localeCompare(b.name || b.url || '', undefined, { sensitivity: 'base' }));
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
