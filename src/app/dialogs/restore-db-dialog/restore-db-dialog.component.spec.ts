import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { NEVER, of, throwError } from 'rxjs';

import { RestoreDbDialogComponent } from './restore-db-dialog.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('RestoreDbDialogComponent', () => {
  let postsService: any;
  let dialogRef: any;
  let data: any;

  // Newest first, the way the server sends them.
  const BACKUPS = [
    { name: 'local_db.json.1700000100.25.bak', timestamp: 1700000100, size: 2048, source: 'local' },
    { name: 'remote_db.json.1700000000.bak', timestamp: 1700000000, size: 1024, source: 'remote' }
  ];

  // The list is asked for as the dialog is made, so what it gets has to be set up first.
  const create = () => {
    const fixture = TestBed.createComponent(RestoreDbDialogComponent);
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, text: (): string => fixture.nativeElement.textContent };
  };

  beforeEach(async () => {
    postsService = {
      getDBBackups: vi.fn().mockName('getDBBackups').mockReturnValue(of({ db_backups: BACKUPS })),
      restoreDBBackup: vi.fn().mockName('restoreDBBackup').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialogRef = { close: vi.fn().mockName('close') };
    data = {};
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await configureTestBed({
      imports: [RestoreDbDialogComponent],
      providers: [
        { provide: PostsService, useValue: postsService },
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: MAT_DIALOG_DATA, useFactory: () => data }
      ]
    }).compileComponents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the backups with their size and where they came from', () => {
    const { component, text } = create();

    expect(component.loading).toBe(false);
    expect(component.db_backups).toEqual(BACKUPS);
    expect(text()).toContain('2.05 kB');
    expect(text()).toContain('remote');
  });

  it('shows that it is loading rather than that there are no backups', () => {
    // It said there were none until the list arrived.
    postsService.getDBBackups.mockReturnValue(NEVER);

    const { fixture, text } = create();

    expect(fixture.nativeElement.querySelector('.list-loading')).not.toBeNull();
    expect(text()).not.toContain('There are no backups');
  });

  it('says only an admin can restore when it is refused the list', () => {
    // Managing tasks is enough to open it, and the refusal read as there being no backups.
    postsService.getDBBackups.mockReturnValue(throwError(() => ({ status: 403 })));

    const { text } = create();

    expect(text()).toContain('Only an admin can restore the database.');
    expect(text()).not.toContain('There are no backups');
  });

  it('says it could not load the list when the request fails otherwise', () => {
    postsService.getDBBackups.mockReturnValue(throwError(() => ({ status: 0 })));

    const { text } = create();

    expect(text()).toContain("Couldn't load the backups.");
  });

  it('says when there are no backups yet', () => {
    postsService.getDBBackups.mockReturnValue(of({ db_backups: [] }));

    const { text } = create();

    expect(text()).toContain('There are no backups to restore from yet.');
  });

  it('starts from the backups it was handed while it asks for the rest', () => {
    data = { db_backups: [BACKUPS[1]] };
    postsService.getDBBackups.mockReturnValue(NEVER);

    const { component } = create();

    expect(component.db_backups).toEqual([BACKUPS[1]]);
  });

  it('picks one backup at a time, and lets go of it when it is picked again', () => {
    const { component } = create();

    component.select(BACKUPS[0]);
    expect(component.isSelected(BACKUPS[0])).toBe(true);

    component.select(BACKUPS[1]);
    expect(component.isSelected(BACKUPS[0])).toBe(false);
    expect(component.selected_backup).toEqual([BACKUPS[1].name]);

    component.select(BACKUPS[1]);
    expect(component.selected_backup).toBeNull();
  });

  it('does not restore until a backup is picked', () => {
    const { component } = create();

    component.restoreClicked();

    expect(postsService.restoreDBBackup).not.toHaveBeenCalled();
  });

  it('restores the backup picked, and closes', () => {
    const { component } = create();

    component.select(BACKUPS[1]);
    component.restoreClicked();

    expect(postsService.restoreDBBackup).toHaveBeenCalledWith(BACKUPS[1].name);
    expect(component.restoring).toBe(false);
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Database successfully restored!');
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('stays open and says so when the restore did not work', () => {
    postsService.restoreDBBackup.mockReturnValue(of({ success: false }));
    const { component } = create();

    component.select(BACKUPS[0]);
    component.restoreClicked();

    expect(component.restoring).toBe(false);
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Failed to restore database! See logs for more info.');
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('stays open and says so when the restore request fails', () => {
    postsService.restoreDBBackup.mockReturnValue(throwError(() => new Error('offline')));
    const { component } = create();

    component.select(BACKUPS[0]);
    component.restoreClicked();

    expect(component.restoring).toBe(false);
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Failed to restore database! See browser console for more info.');
    expect(dialogRef.close).not.toHaveBeenCalled();
  });
});
