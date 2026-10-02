import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of, Subject, throwError } from 'rxjs';

import { CreatePlaylistComponent, PlaylistDialogData } from './create-playlist.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../testing/test-bed';

describe('CreatePlaylistComponent', () => {
  let component: CreatePlaylistComponent;
  let fixture: ComponentFixture<CreatePlaylistComponent>;
  let postsServiceStub: any;
  let dialogRefStub: any;

  const file = (uid: string, overrides: Record<string, unknown> = {}) => ({
    uid,
    id: uid,
    title: `Title ${uid}`,
    uploader: 'An uploader',
    thumbnailURL: `https://example.com/${uid}.jpg`,
    isAudio: false,
    duration: 60,
    registered: 1_700_000_000_000,
    ...overrides
  }) as any;

  const library = [
    file('a', { title: 'Apollo 11 moonwalk', uploader: 'NASA' }),
    file('b', { title: 'Station tour', uploader: 'NASA' }),
    file('c', { title: 'Jupiter', uploader: 'JPL', duration: '1:02:03' })
  ];

  async function create(data: PlaylistDialogData) {
    configureTestBed({
      imports: [CreatePlaylistComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: MatDialogRef, useValue: dialogRefStub },
        { provide: MAT_DIALOG_DATA, useValue: data }
      ]
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(CreatePlaylistComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    postsServiceStub = {
      path: '/api/',
      isLoggedIn: false,
      token: '',
      // Copies, as a response is: what one case writes on a file must not reach the next.
      getAllFiles: vi.fn().mockName('getAllFiles').mockImplementation(() => of({ files: library.map(item => ({...item})), file_count: library.length })),
      getAllSubscriptions: vi.fn().mockName('getAllSubscriptions').mockReturnValue(of({
        subscriptions: [{ id: 'sub-1', name: 'A channel' }]
      })),
      getPlaylist: vi.fn().mockName('getPlaylist').mockImplementation(() => of({
        playlist: { id: 'playlist-1', name: 'Space', uids: ['c', 'a'] },
        file_objs: [{...library[2]}, {...library[0]}],
        success: true
      })),
      createPlaylist: vi.fn().mockName('createPlaylist').mockReturnValue(of({ success: true })),
      updatePlaylist: vi.fn().mockName('updatePlaylist').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar'),
      hasPermission: vi.fn().mockName('hasPermission').mockReturnValue(true),
      generateThumbnail: vi.fn().mockName('generateThumbnail').mockReturnValue(of({
        success: true, thumbnailPath: 'video/c.webp', thumbnail_updated_at: 1_800_000_000_000, method: 'source'
      })),
      playlists_changed: { next: vi.fn().mockName('playlists_changed.next') }
    };
    dialogRefStub = { close: vi.fn().mockName('close') };
  });

  // The library opens this dialog. When the dialog embedded the library too, the two imported
  // each other, and a production build evaluated this one first: its imports held undefined,
  // which Angular reports as NG0919 and shows as an empty surface.
  it('does not embed the media library that opens it', () => {
    const dependencies = (CreatePlaylistComponent as any).ɵcmp.dependencies;
    const types: any[] = (typeof dependencies === 'function' ? dependencies() : dependencies) ?? [];
    expect(types.every(Boolean)).toBe(true);
    const selectors = types.map(type => JSON.stringify(type.ɵcmp?.selectors ?? type.ɵdir?.selectors ?? '')).join(' ');
    expect(selectors).not.toContain('app-media-library');
  });

  describe('creating', () => {
    beforeEach(() => create({ create_mode: true }));

    it('renders the editor, starting on the library', () => {
      const element: HTMLElement = fixture.nativeElement;
      expect(element.querySelector('.dialog-title').textContent).toContain('Create a playlist');
      expect(element.querySelector('.playlist-controls input')).not.toBeNull();
      expect(component.view).toBe('library');
      expect(element.querySelectorAll('.file-row').length).toBe(3);
    });

    it('asks for the whole library, whatever the library page is filtered to', () => {
      expect(postsServiceStub.getAllFiles).toHaveBeenCalledWith(
        { by: 'registered', order: -1 }, null, null, 'both', false, null, false, []
      );
    });

    it('adds a picked file to the end, and takes it back out when picked again', () => {
      component.toggle(library[1]);
      component.toggle(library[0]);
      expect(component.selected.map(selected => selected.uid)).toEqual(['b', 'a']);

      component.toggle(library[1]);
      expect(component.selected.map(selected => selected.uid)).toEqual(['a']);
      expect(component.matching_selected_count).toBe(1);
    });

    it('searches titles and uploaders, and selects only what matches', () => {
      component.searchChanged('nasa');
      expect(component.matching.map(match => match.uid)).toEqual(['a', 'b']);

      component.toggleAllMatching();
      expect(component.selected.map(selected => selected.uid)).toEqual(['a', 'b']);
      expect(component.all_matching_selected).toBe(true);

      component.toggleAllMatching();
      expect(component.selected).toEqual([]);
    });

    it('selects hundreds of files without doubling any up', () => {
      const many = Array.from({ length: 300 }, (_, index) => file(`file-${index}`));
      postsServiceStub.getAllFiles.mockReturnValue(of({ files: many, file_count: many.length }));
      component.getFiles();
      component.toggle(many[5]);

      component.toggleAllMatching();

      expect(component.selected.length).toBe(300);
      expect(new Set(component.selected.map(selected => selected.uid)).size).toBe(300);
      expect(component.selected[0].uid).toBe('file-5');
      // Only a page of rows is drawn at a time; the rest are a click away.
      expect(component.shown.length).toBe(CreatePlaylistComponent.PAGE_SIZE);
      expect(component.hidden_count).toBe(200);
    });

    it('asks again for one source, and ignores an answer for the source it replaced', () => {
      const first = new Subject<any>();
      const second = new Subject<any>();
      postsServiceStub.getAllFiles.mockReturnValueOnce(first.asObservable()).mockReturnValueOnce(second.asObservable());
      component.getFiles();

      component.sourceChanged('sub-1');
      first.next({ files: [file('wrong-source')], file_count: 1 });
      expect(component.files).toEqual([]);
      expect(postsServiceStub.getAllFiles).toHaveBeenLastCalledWith(
        { by: 'registered', order: -1 }, null, null, 'both', false, 'sub-1', false, []
      );

      second.next({ files: [file('right-source')], file_count: 1 });
      expect(component.files.map(listed => listed.uid)).toEqual(['right-source']);
    });

    it('offers the subscriptions as sources', () => {
      expect(component.sourceOptions.map(option => option.value)).toEqual([null, 'sub-1']);
    });

    it('reorders by dragging, by keyboard, and all at once', () => {
      library.forEach(listed => component.toggle(listed));

      component.drop({ previousIndex: 0, currentIndex: 2 } as any);
      expect(component.selected.map(selected => selected.uid)).toEqual(['b', 'c', 'a']);

      component.move(2, -1);
      expect(component.selected.map(selected => selected.uid)).toEqual(['b', 'a', 'c']);
      component.move(0, -1);
      expect(component.selected.map(selected => selected.uid)).toEqual(['b', 'a', 'c']);

      component.reverse();
      expect(component.selected.map(selected => selected.uid)).toEqual(['c', 'a', 'b']);

      component.remove(1);
      expect(component.selected.map(selected => selected.uid)).toEqual(['c', 'b']);
      expect(component.isSelected(library[0])).toBe(false);
    });

    it('adds up how long the playlist runs', () => {
      component.toggle(library[0]);
      component.toggle(library[2]);
      expect(component.total_duration).toBe('1:03:03');
    });

    it('needs a name and at least one file before it can be created', () => {
      expect(component.can_save).toBe(false);
      component.name = '   ';
      component.toggle(library[0]);
      expect(component.can_save).toBe(false);
      component.name = 'Moon';
      expect(component.can_save).toBe(true);
    });

    it('creates it in the order shown, with the first file as its thumbnail, and closes', () => {
      component.name = '  Moon  ';
      component.toggle(library[1]);
      component.toggle(library[0]);

      component.save();

      expect(postsServiceStub.createPlaylist).toHaveBeenCalledWith('Moon', ['b', 'a'], 'https://example.com/b.jpg');
      expect(postsServiceStub.playlists_changed.next).toHaveBeenCalledWith(true);
      expect(dialogRefStub.close).toHaveBeenCalledWith(true);
    });

    it('stays open with the selection intact when creating fails', () => {
      postsServiceStub.createPlaylist.mockReturnValue(throwError(() => new Error('offline')));
      component.name = 'Moon';
      component.toggle(library[0]);

      component.save();

      expect(dialogRefStub.close).not.toHaveBeenCalled();
      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('ERROR: failed to create playlist!');
      expect(component.selected.length).toBe(1);
      expect(component.saving).toBe(false);
    });
  });

  describe('editing', () => {
    beforeEach(() => create({ playlist_id: 'playlist-1' }));

    it('starts on what is already in the playlist, in its order', () => {
      expect(postsServiceStub.getPlaylist).toHaveBeenCalledWith('playlist-1', null, true);
      expect(component.view).toBe('playlist');
      expect(component.name).toBe('Space');
      expect(component.selected.map(selected => selected.uid)).toEqual(['c', 'a']);
      expect(fixture.nativeElement.querySelectorAll('.order-row').length).toBe(2);
    });

    it('marks the files already in it as picked in the library', () => {
      expect(component.isSelected(library[0])).toBe(true);
      expect(component.isSelected(library[1])).toBe(false);
      expect(component.matching_selected_count).toBe(2);
    });

    it('has nothing to save until something changes', () => {
      expect(component.can_save).toBe(false);
      component.reverse();
      expect(component.can_save).toBe(true);
      component.reverse();
      expect(component.can_save).toBe(false);
      component.name = 'Space and more';
      expect(component.can_save).toBe(true);
    });

    it('saves the new name and order, and closes', () => {
      component.name = 'Planets';
      component.reverse();

      component.save();

      expect(postsServiceStub.updatePlaylist).toHaveBeenCalledWith(expect.objectContaining({
        id: 'playlist-1', name: 'Planets', uids: ['a', 'c']
      }));
      expect(postsServiceStub.playlists_changed.next).toHaveBeenCalledWith(true);
      expect(dialogRefStub.close).toHaveBeenCalledWith(true);
    });

    it('says so when saving fails, rather than that it worked', () => {
      postsServiceStub.updatePlaylist.mockReturnValue(of({ success: false }));
      component.reverse();

      component.save();

      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Failed to update playlist.');
      expect(dialogRefStub.close).not.toHaveBeenCalled();
    });

    describe('cover art', () => {
      const regenerateButton = (): HTMLButtonElement | undefined => Array.from<HTMLButtonElement>(
        fixture.nativeElement.querySelectorAll('.dialog-actions button')).find(button => button.textContent.includes('Regenerate cover art'));

      it('makes the art of the file that plays first again, and shows the new art', () => {
        regenerateButton().click();
        fixture.detectChanges();

        expect(postsServiceStub.generateThumbnail).toHaveBeenCalledWith('c', null);
        expect(component.selected[0].thumbnail_updated_at).toBe(1_800_000_000_000);
        const first_row_image: HTMLImageElement = fixture.nativeElement.querySelector('.order-row img');
        expect(first_row_image.getAttribute('src')).toBe('/api/thumbnail/c?v=1800000000000');
        // The library's copy of the same file too, for its row on the other tab.
        expect(component.files.find(item => item.uid === 'c').thumbnail_updated_at).toBe(1_800_000_000_000);
        expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Cover art fetched from the original.');
        expect(postsServiceStub.playlists_changed.next).toHaveBeenCalledWith(true);
        // Nothing else about the playlist changed, so there is still nothing to save.
        expect(component.can_save).toBe(false);
        expect(dialogRefStub.close).not.toHaveBeenCalled();
      });

      it('follows the order shown, saved or not', () => {
        component.reverse();
        fixture.detectChanges();

        regenerateButton().click();

        expect(postsServiceStub.generateThumbnail).toHaveBeenCalledWith('a', null);
      });

      it('says when the art came from a frame of the video', () => {
        postsServiceStub.generateThumbnail.mockReturnValue(of({ success: true, thumbnailPath: 'video/c.webp', thumbnail_updated_at: 1, method: 'frame', seek_seconds: 30 }));

        regenerateButton().click();

        expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Cover art taken from the video.');
      });

      it('says so when it could not, and leaves the art as it was', () => {
        postsServiceStub.generateThumbnail.mockReturnValue(of({ success: false }));

        regenerateButton().click();

        expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Could not generate cover art for this playlist.');
        expect(component.selected[0].thumbnail_updated_at).toBeUndefined();
        expect(postsServiceStub.playlists_changed.next).not.toHaveBeenCalled();
        expect(component.regenerating_cover).toBe(false);
      });

      it('is offered only to those who may manage files', () => {
        postsServiceStub.hasPermission.mockReturnValue(false);
        fixture.detectChanges();

        expect(regenerateButton()).toBeUndefined();
        expect(postsServiceStub.hasPermission).toHaveBeenCalledWith('filemanager');
      });
    });
  });

  it('offers no cover art to make while creating, as there is no playlist yet', async () => {
    await create({ create_mode: true });
    component.toggle(library[0]);
    fixture.detectChanges();

    expect(component.can_regenerate_cover).toBe(false);
  });
});
