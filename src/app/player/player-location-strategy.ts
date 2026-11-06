import { HashLocationStrategy, PlatformLocation } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { compactPlayerPath } from '../utils/player-link';

// Keep existing hash routes and bookmarks, but give the player a short, ordinary path.
// The backend already serves the app at extensionless paths. These single-segment paths
// also keep the app's relative base href working behind a subdirectory proxy.
@Injectable()
export class PlayerLocationStrategy extends HashLocationStrategy {
  private readonly platform = inject(PlatformLocation);

  override path(includeHash = false): string {
    const hash = super.path(includeHash);
    if (hash) return hash;
    return compactPlayerPath(this.platform.pathname, this.platform.search) ?? hash;
  }

  override prepareExternalUrl(internal: string): string {
    const base = this.getBaseHref() || this.platform.getBaseHrefFromDOM() || '/';
    const root = base.endsWith('/') ? base : base + '/';
    if (/^\/(video|audio|playlist)(\?|$)/.test(internal)) {
      return root + internal.slice(1);
    }
    return root + '#' + internal;
  }
}
