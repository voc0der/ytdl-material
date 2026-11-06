import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

@Injectable()
export class PlayerRouteReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, current: ActivatedRouteSnapshot): boolean {
    // A different video or clip uses the same root path. Recreate the player so it releases
    // the old stream and initializes playback and queue state for the new history entry.
    return !future.routeConfig?.data?.['player'] && super.shouldReuseRoute(future, current);
  }
}
