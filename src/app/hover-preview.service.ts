import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class HoverPreviewService {
  private stopActivePreview: (() => void) | null = null;

  activate(stopPreview: () => void): void {
    if (this.stopActivePreview === stopPreview) return;
    this.stopActivePreview?.();
    this.stopActivePreview = stopPreview;
  }

  release(stopPreview: () => void): void {
    // An old card can be destroyed after the next one has already claimed the preview.
    if (this.stopActivePreview === stopPreview) this.stopActivePreview = null;
  }
}
