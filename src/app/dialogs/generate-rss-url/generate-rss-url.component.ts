import { Component, ChangeDetectionStrategy } from '@angular/core';
import { Router, UrlSerializer } from '@angular/router';
import { Sort } from 'api-types';
import { PostsService } from 'app/posts.services';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { SortPropertyComponent } from '../../components/sort-property/sort-property.component';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';

@Component({
    selector: 'app-generate-rss-url',
    templateUrl: './generate-rss-url.component.html',
    styleUrls: ['./generate-rss-url.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, FormsModule, SortPropertyComponent, MatSlideToggle, MatTooltip, MatIcon, MatProgressSpinner, PickerComponent, MatDialogActions, MatDialogClose]
})
export class GenerateRssUrlComponent {
  titleFilter = '';
  subscriptionFilter = '';
  fileTypeFilter = 'both';
  itemLimit = null;
  favoriteFilter = false;
  url = '';
  baseURL = `${this.postsService.config.Host.url}:${this.postsService.config.Host.port}/api/rss`
  sortProperty = 'registered'
  descendingMode = true
  apiToken = null;
  tokenLoading = false;
  tokenError = null;
  multiUserMode = !!this.postsService.config?.Advanced?.multi_user_mode;

  readonly fileTypeLabel = $localize`File type`;
  readonly subscriptionLabel = $localize`Subscription`;
  readonly tokenLabel = $localize`RSS token`;
  readonly urlLabel = $localize`URL`;

  readonly fileTypeOptions: PickerOption[] = [
    { value: 'both', label: $localize`Both` },
    { value: 'video_only', label: $localize`Video only` },
    { value: 'audio_only', label: $localize`Audio only` }
  ];

  get subscriptionOptions(): PickerOption[] {
    return [
      { value: '', label: $localize`None` },
      ...(this.postsService.subscriptions ?? []).map(sub => ({ value: sub.id, label: sub.name }))
    ];
  }
  constructor(public postsService: PostsService, private router: Router, private serializer: UrlSerializer, private clipboard: Clipboard) {
    this.url = this.baseURL;
    this.rebuildURL();
  }

  generateFeedToken() {
    this.tokenLoading = true;
    this.tokenError = null;
    this.postsService.generateAPIToken('RSS feed', 'rss').subscribe(res => {
      this.tokenLoading = false;
      if (!res?.success || !res.token) {
        this.tokenError = res?.error || $localize`Could not generate an RSS token.`;
        return;
      }
      this.apiToken = res.token;
    }, err => {
      this.tokenLoading = false;
      this.tokenError = err?.error?.error || err || $localize`Could not generate an RSS token.`;
    });
  }

  fileTypeChanged(file_type: string) {
    this.fileTypeFilter = file_type;
    this.rebuildURL();
  }

  subscriptionChanged(sub_id: string) {
    this.subscriptionFilter = sub_id;
    this.rebuildURL();
  }

  sortOptionChanged(sort: Sort) {
    this.descendingMode = sort['order'] === -1;
    this.sortProperty = sort['by'];
    this.rebuildURL();
  }

  rebuildURL() {
    // code can be cleaned up
    const params = {};

    if (this.titleFilter) {
      params['text_search'] = encodeURIComponent(this.titleFilter);
    }

    if (this.subscriptionFilter) {
      params['sub_id'] = encodeURIComponent(this.subscriptionFilter);
    }

    if (this.itemLimit) {
      params['range'] = [0, this.itemLimit];
    }

    if (this.favoriteFilter) {
      params['favorite_filter'] = this.favoriteFilter;
    }

    if (this.fileTypeFilter !== 'both') {
      params['file_type_filter'] = this.fileTypeFilter;
    }

    if (this.sortProperty !== 'registered' || !this.descendingMode) {
      params['sort'] = encodeURIComponent(JSON.stringify({by: this.sortProperty, order: this.descendingMode ? -1 : 1}));
    }

    const tree = this.router.createUrlTree(['..'], { queryParams: params });

    this.url = `${this.baseURL}${this.serializer.serialize(tree)}`;
  }

  copyURL() {
    if (this.multiUserMode && !this.apiToken) return;
    this.clipboard.copy(this.url);
    this.postsService.openSnackBar('URL copied!');
  }

  copyFeedToken() {
    if (!this.apiToken) return;
    this.clipboard.copy(this.apiToken);
    this.postsService.openSnackBar($localize`RSS token copied.`);
  }
}
