import { Injectable } from '@angular/core';
import { DatabaseFile, Playlist } from 'api-types';

export const PLAYER_NAVIGATOR_STORAGE_KEY = 'player_navigator';
export const MEDIA_LIBRARY_RESTORE_SNAPSHOT_STORAGE_KEY = 'media_library_restore_snapshot';

export interface MediaLibraryRestoreSnapshot {
  routeKey: string;
  activeLibraryTab: number;
  sortProperty: string;
  descendingMode: boolean;
  selectedFilters: string[];
  searchText: string;
  playlistSearchText: string;
  autoPaginationEnabled: boolean;
  pageSize: number;
  manualPageIndex: number;
  subId: string | null;
  fileCount: number;
  loadedCount: number;
  anchorUid: string | null;
  anchorOffset: number;
  scrollTop: number;
}

export interface MediaLibraryRestoreState {
  snapshot: MediaLibraryRestoreSnapshot;
  files: DatabaseFile[];
  playlistLibraryItems: Playlist[];
  playlistLibraryReceived: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class MediaLibraryNavigationStateService {
  private pendingRestoreState: MediaLibraryRestoreState | null = null;

  savePendingRestoreState(state: MediaLibraryRestoreState): void {
    this.pendingRestoreState = this.cloneState(state);
    sessionStorage.setItem(
      MEDIA_LIBRARY_RESTORE_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(this.pendingRestoreState.snapshot)
    );
  }

  consumePendingRestoreState(routeKey: string, subId: string | null): MediaLibraryRestoreState | null {
    if (this.matchesSnapshot(this.pendingRestoreState?.snapshot, routeKey, subId)) {
      const state = this.cloneState(this.pendingRestoreState);
      this.clearPendingRestoreState();
      return state;
    }

    const stored_snapshot = this.getStoredSnapshot();
    if (!this.matchesSnapshot(stored_snapshot, routeKey, subId)) {
      return null;
    }

    this.clearPendingRestoreState();
    return {
      snapshot: stored_snapshot,
      files: [],
      playlistLibraryItems: [],
      playlistLibraryReceived: false
    };
  }

  clearPendingRestoreState(): void {
    this.pendingRestoreState = null;
    sessionStorage.removeItem(MEDIA_LIBRARY_RESTORE_SNAPSHOT_STORAGE_KEY);
  }

  private matchesSnapshot(snapshot: MediaLibraryRestoreSnapshot | null | undefined, routeKey: string, subId: string | null): boolean {
    if (!snapshot) {
      return false;
    }

    return snapshot.routeKey === routeKey && snapshot.subId === (subId ?? null);
  }

  private getStoredSnapshot(): MediaLibraryRestoreSnapshot | null {
    const raw_snapshot = sessionStorage.getItem(MEDIA_LIBRARY_RESTORE_SNAPSHOT_STORAGE_KEY);
    if (!raw_snapshot) {
      return null;
    }

    try {
      return JSON.parse(raw_snapshot) as MediaLibraryRestoreSnapshot;
    } catch (error) {
      console.error('Failed to parse stored media-library restore snapshot', error);
      sessionStorage.removeItem(MEDIA_LIBRARY_RESTORE_SNAPSHOT_STORAGE_KEY);
      return null;
    }
  }

  private cloneState(state: MediaLibraryRestoreState): MediaLibraryRestoreState {
    return {
      snapshot: {
        ...state.snapshot,
        selectedFilters: Array.isArray(state.snapshot.selectedFilters) ? [...state.snapshot.selectedFilters] : []
      },
      files: this.cloneFiles(state.files),
      playlistLibraryItems: this.clonePlaylists(state.playlistLibraryItems),
      playlistLibraryReceived: !!state.playlistLibraryReceived
    };
  }

  private cloneFiles(files: DatabaseFile[] | null | undefined): DatabaseFile[] {
    if (!Array.isArray(files)) {
      return [];
    }

    return files.map(file => ({
      ...file,
      chapters: Array.isArray(file?.chapters)
        ? file.chapters.map(chapter => ({...chapter}))
        : file?.chapters
    }));
  }

  private clonePlaylists(playlists: Playlist[] | null | undefined): Playlist[] {
    if (!Array.isArray(playlists)) {
      return [];
    }

    return playlists.map(playlist => ({
      ...playlist,
      uids: Array.isArray(playlist?.uids) ? [...playlist.uids] : playlist?.uids
    }));
  }
}
