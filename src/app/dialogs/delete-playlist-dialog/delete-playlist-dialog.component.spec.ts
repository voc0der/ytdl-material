import { of } from 'rxjs';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { DeletePlaylistDialogComponent } from './delete-playlist-dialog.component';

describe('DeletePlaylistDialogComponent', () => {
  let dialogRefSpy: any;
  let matDialogSpy: any;
  let component: DeletePlaylistDialogComponent;

  beforeEach(() => {
    dialogRefSpy = {
      close: vi.fn().mockName('close')
    };
    matDialogSpy = {
      open: vi.fn().mockName('open')
    };
    component = new DeletePlaylistDialogComponent({
      playlistName: 'My playlist',
      fileCount: 3
    }, matDialogSpy, dialogRefSpy);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('closes immediately when deleting only the playlist', () => {
    component.deletePlaylistOnly();

    expect(dialogRefSpy.close).toHaveBeenCalledWith('playlist_only');
  });

  it('requires a second confirmation before deleting playlist files', () => {
    matDialogSpy.open.mockReturnValue({ afterClosed: () => of(true) });

    component.confirmDeletePlaylistAndFiles();

    expect(matDialogSpy.open).toHaveBeenCalledWith(ConfirmDialogComponent, expect.objectContaining({
      data: expect.objectContaining({
        dialogTitle: 'Delete playlist files',
        submitText: 'Delete files too',
        warnSubmitColor: true
      })
    }));
    expect(dialogRefSpy.close).toHaveBeenCalledWith('playlist_and_files');
  });
});
