import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { openPlaylistDialog } from 'app/create-playlist/create-playlist.component';
import { DeletePlaylistResponse, Playlist } from 'api-types';
import { DeletePlaylistDialogComponent, DeletePlaylistDialogAction } from 'app/dialogs/delete-playlist-dialog/delete-playlist-dialog.component';
import { saveBlob } from '../../utils/save-blob';
import { filter, take } from 'rxjs/operators';
import { PLAYER_NAVIGATOR_STORAGE_KEY } from 'app/media-library-navigation-state.service';
import { NgClass } from '@angular/common';
import { UnifiedFileCardComponent } from '../unified-file-card/unified-file-card.component';
import { MatFabButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';

@Component({
    selector: 'app-custom-playlists',
    templateUrl: './custom-playlists.component.html',
    styleUrls: ['./custom-playlists.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [NgClass, UnifiedFileCardComponent, MatFabButton, MatIcon]
})
export class CustomPlaylistsComponent implements OnInit {

  playlists = null;
  playlists_received = false;
  downloading_content = {'video': {}, 'audio': {}};

  constructor(public postsService: PostsService, private router: Router, private dialog: MatDialog) { }

  ngOnInit(): void {
    this.postsService.service_initialized
      .pipe(filter(Boolean), take(1))
      .subscribe(() => this.getAllPlaylists());

    this.postsService.playlists_changed.subscribe(changed => {
      if (changed) {
        this.getAllPlaylists();
      }
    });
  }

  getAllPlaylists(): void {
    this.playlists_received = false;
    // must call getAllFiles as we need to get category playlists as well
    this.postsService.getPlaylists(true).subscribe(res => {
      this.playlists = res['playlists'];
      this.playlists_received = true;
    });
  }

  // The dialog reports what it saved on playlists_changed, which is what refreshes the list.
  openCreatePlaylistDialog(): void {
    openPlaylistDialog(this.dialog, {create_mode: true});
  }

  goToPlaylist(info_obj: { file: Playlist; }): void {
    const playlist = info_obj.file;
    const playlistID = playlist.id;

    if (playlist) {
      if (this.postsService.config['Extra']['download_only_mode']) {
        this.downloadPlaylist(playlist.id, playlist.name);
      } else {
        sessionStorage.setItem(PLAYER_NAVIGATOR_STORAGE_KEY, this.router.url);
        const routeParams = {playlist_id: playlistID};
        if (playlist.auto) { routeParams['auto'] =  playlist.auto; }
        this.router.navigate(['/player', routeParams]);
      }
    } else {
      // playlist not found
      // TODO: Make translatable
      console.error(`Playlist with ID ${playlistID} not found!`);
    }
  }

  downloadPlaylist(playlist_id: string, playlist_name: string): void {
    this.downloading_content[playlist_id] = true;
    this.postsService.downloadPlaylistFromServer(playlist_id).subscribe(res => {
      this.downloading_content[playlist_id] = false;
      const blob: any = res;
      saveBlob(blob, playlist_name + '.zip');
    });

  }

  deletePlaylist(args: { file: Playlist; index: number; }): void {
    const playlist = args.file;
    const dialogRef = this.dialog.open(DeletePlaylistDialogComponent, {
      data: {
        playlistName: playlist.name,
        fileCount: Array.isArray(playlist.uids) ? playlist.uids.length : 0
      },
      width: '440px',
      panelClass: 'kit-dialog-panel',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });

    dialogRef.afterClosed().pipe(take(1)).subscribe((action: DeletePlaylistDialogAction | undefined) => {
      if (!action) return;
      this.removePlaylist(playlist, action === 'playlist_and_files');
    });
  }

  private removePlaylist(playlist: Playlist, delete_files: boolean): void {
    this.postsService.removePlaylist(playlist.id, delete_files).subscribe((res: DeletePlaylistResponse) => {
      const playlist_removed = !!res?.playlist_removed || !!res?.success;
      if (playlist_removed) {
        if (Array.isArray(this.playlists)) {
          this.playlists = this.playlists.filter(existing_playlist => existing_playlist.id !== playlist.id);
        }
        const failed_file_count = Number(res?.failed_file_count) || 0;
        if (delete_files && failed_file_count > 0) {
          this.postsService.openSnackBar($localize`Playlist removed, but ${failed_file_count}:failed file count: file(s) could not be deleted.`);
        } else {
          this.postsService.openSnackBar(delete_files
            ? $localize`Playlist and files successfully removed.`
            : $localize`Playlist successfully removed.`);
        }
      } else {
        this.postsService.openSnackBar(delete_files
          ? $localize`Failed to remove playlist and files.`
          : $localize`Failed to remove playlist.`);
      }
      this.getAllPlaylists();
    }, () => {
      this.postsService.openSnackBar(delete_files
        ? $localize`Failed to remove playlist and files.`
        : $localize`Failed to remove playlist.`);
      this.getAllPlaylists();
    });
  }

  editPlaylistDialog(args: { playlist: Playlist; index: number; }): void {
    openPlaylistDialog(this.dialog, {playlist_id: args.playlist.id});
  }

}
