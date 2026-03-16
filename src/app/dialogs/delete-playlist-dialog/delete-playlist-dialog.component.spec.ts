import { of } from 'rxjs';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { DeletePlaylistDialogComponent } from './delete-playlist-dialog.component';

describe('DeletePlaylistDialogComponent', () => {
  let dialogRefSpy: any;
  let matDialogSpy: any;
  let component: DeletePlaylistDialogComponent;

  beforeEach(() => {
    dialogRefSpy = {
      close: jasmine.createSpy('close')
    };
    matDialogSpy = {
      open: jasmine.createSpy('open')
    };
    component = new DeletePlaylistDialogComponent(
      {
        playlistName: 'My playlist',
        fileCount: 3
      },
      matDialogSpy,
      dialogRefSpy
    );
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('closes immediately when deleting only the playlist', () => {
    component.deletePlaylistOnly();

    expect(dialogRefSpy.close).toHaveBeenCalledWith('playlist_only');
  });

  it('requires a second confirmation before deleting playlist files', () => {
    matDialogSpy.open.and.returnValue({ afterClosed: () => of(true) });

    component.confirmDeletePlaylistAndFiles();

    expect(matDialogSpy.open).toHaveBeenCalledWith(ConfirmDialogComponent, jasmine.objectContaining({
      data: jasmine.objectContaining({
        dialogTitle: 'Delete playlist files',
        submitText: 'Delete files too',
        warnSubmitColor: true
      })
    }));
    expect(dialogRefSpy.close).toHaveBeenCalledWith('playlist_and_files');
  });
});
