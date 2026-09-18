import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { of, Subject } from 'rxjs';

import { DuplicatesComponent } from './duplicates.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('DuplicatesComponent', () => {
  let component: DuplicatesComponent;
  let fixture: ComponentFixture<DuplicatesComponent>;
  let postsServiceStub: any;
  let dialogStub: any;
  let routerStub: any;

  const copy = (uid: string, registered: number) => ({
    uid, title: `Copy ${uid}`, registered, path: `video/${uid}.mp4`, thumbnailURL: '', isAudio: false, duration: 90
  }) as any;

  const group = (key: string, title: string, copies: any[]) => ({
    duplicate_key: key,
    source_id: `${key}-id`,
    source_extractor: 'generic',
    isAudio: false,
    duplicate_count: copies.length - 1,
    total_count: copies.length,
    kept_file: { ...copies[0], title },
    duplicate_files: copies,
    newest_registered: copies[copies.length - 1].registered
  }) as any;

  // Told apart by each order: newest download, number of copies, title.
  const groups = [
    group('moon', 'Moonwalk', [copy('m1', 100), copy('m2', 900)]),
    group('launch', 'Launch', [copy('l1', 200), copy('l2', 300), copy('l3', 400), copy('l4', 500)]),
    group('apollo', 'Apollo', [copy('a1', 50), copy('a2', 600), copy('a3', 700)])
  ];

  async function create() {
    configureTestBed({
      imports: [DuplicatesComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: MatDialog, useValue: dialogStub },
        { provide: Router, useValue: routerStub }
      ]
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(DuplicatesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    postsServiceStub = {
      initialized: true,
      config: { Extra: { file_manager_enabled: true } },
      hasPermission: () => true,
      path: '/api/',
      isLoggedIn: false,
      token: '',
      files_changed: new Subject<boolean>(),
      getDuplicates: vi.fn().mockName('getDuplicates').mockReturnValue(of({ duplicates: groups })),
      removeDuplicates: vi.fn().mockName('removeDuplicates').mockReturnValue(of({ success: true, removed_uids: ['m2'] })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialogStub = { open: vi.fn().mockName('open').mockReturnValue({ afterClosed: () => of('newest') }) };
    routerStub = { navigate: vi.fn().mockName('navigate') };
  });

  it('lists every file downloaded more than once, latest download first', async () => {
    await create();
    expect(component.sorted.map(listed => listed.duplicate_key)).toEqual(['moon', 'apollo', 'launch']);
    expect(fixture.nativeElement.querySelectorAll('.duplicate-row').length).toBe(3);
  });

  it('says how many there are and how many copies would go', async () => {
    await create();
    const summary: string = fixture.nativeElement.querySelector('.duplicates-summary').textContent;
    expect(summary).toContain('3 files downloaded more than once');
    expect(summary).toContain('6 extra copies');
  });

  it('orders by copies or by title on request', async () => {
    await create();
    component.orderChanged('copies');
    expect(component.sorted.map(listed => listed.duplicate_key)).toEqual(['launch', 'apollo', 'moon']);
    component.orderChanged('title');
    expect(component.sorted.map(listed => listed.duplicate_key)).toEqual(['apollo', 'launch', 'moon']);
  });

  it('shows every copy, oldest first, when a row is opened', async () => {
    await create();
    const row: HTMLElement = fixture.nativeElement.querySelector('.duplicate-row');
    row.querySelector<HTMLButtonElement>('.duplicate-actions .kit-icon-button').click();
    fixture.detectChanges();

    const copies = row.querySelectorAll('.copy-row');
    expect(copies.length).toBe(2);
    expect(copies[0].textContent).toContain('video/m1.mp4');
    expect(copies[0].textContent).toContain('First download');
    expect(copies[1].textContent).toContain('Latest');
  });

  it('cleans up through a confirmation that says which copy stays', async () => {
    await create();
    const cleanUp = fixture.nativeElement.querySelector('.duplicate-actions .kit-chip') as HTMLButtonElement;
    expect(cleanUp.textContent).toContain('Clean up');

    cleanUp.click();

    const data = dialogStub.open.mock.calls[0][1].data;
    expect(data.dialogText).toContain('Moonwalk');
    expect(data.dialogText).toContain('keeps the first download');
    expect(data.submitActions.map(action => action.value)).toEqual(['newest', 'oldest']);
    expect(postsServiceStub.removeDuplicates).toHaveBeenCalledWith('moon', 'newest');
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Newest duplicates removed.');
  });

  it('removes nothing when the confirmation is dismissed', async () => {
    dialogStub.open.mockReturnValue({ afterClosed: () => of(undefined) });
    await create();

    component.openRemoveDuplicatesDialog(groups[0]);

    expect(postsServiceStub.removeDuplicates).not.toHaveBeenCalled();
  });

  it('pages a long list', async () => {
    const many = Array.from({ length: 45 }, (_, index) => group(`key-${index}`, `Title ${index}`, [copy(`${index}a`, index), copy(`${index}b`, 1000 + index)]));
    postsServiceStub.getDuplicates.mockReturnValue(of({ duplicates: many }));
    await create();

    expect(component.page_groups.length).toBe(DuplicatesComponent.PAGE_SIZE);
    component.goToPage(2);
    expect(component.page_groups.length).toBe(5);
    expect(fixture.nativeElement.querySelector('.pager')).not.toBeNull();
  });

  it('says so when there is nothing to clean up', async () => {
    postsServiceStub.getDuplicates.mockReturnValue(of({ duplicates: [] }));
    await create();
    expect(fixture.nativeElement.querySelector('.empty-state h2').textContent).toContain('No duplicates found!');
  });

  it('sends anyone without the file manager home', async () => {
    postsServiceStub.config.Extra.file_manager_enabled = false;
    await create();
    expect(routerStub.navigate).toHaveBeenCalledWith(['/home']);
    expect(postsServiceStub.getDuplicates).not.toHaveBeenCalled();
  });
});
