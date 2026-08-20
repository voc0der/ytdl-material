import { Component, ChangeDetectionStrategy } from '@angular/core';
import { Router, UrlSerializer } from '@angular/router';
import { Sort } from 'api-types';
import { PostsService } from 'app/posts.services';
import { Clipboard } from '@angular/cdk/clipboard';

@Component({
    selector: 'app-generate-rss-url',
    templateUrl: './generate-rss-url.component.html',
    styleUrls: ['./generate-rss-url.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
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
