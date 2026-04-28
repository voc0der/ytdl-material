import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { EventEmitter } from '@angular/core';
import { of, throwError } from 'rxjs';

import { SettingsComponent } from './settings.component';

describe('SettingsComponent', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;

  beforeEach(waitForAsync(() => {
    TestBed.configureTestingModule({
      declarations: [ SettingsComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('SettingsComponent.deleteOrphanFiles', () => {
  let component: SettingsComponent;
  let posts_service_mock: any;
  let dialog_mock: any;
  let done_emitter: EventEmitter<boolean>;

  beforeEach(() => {
    done_emitter = new EventEmitter<boolean>();

    posts_service_mock = {
      initialized: false,
      service_initialized: of(false),
      config: null,
      openSnackBar: jasmine.createSpy('openSnackBar'),
      deleteOrphanFiles: jasmine.createSpy('deleteOrphanFiles').and.returnValue(
        of({deleted_count: 3, failed_count: 0})
      )
    };

    dialog_mock = {
      open: jasmine.createSpy('open').and.returnValue({
        close: jasmine.createSpy('close')
      })
    };

    const snack_bar_mock: any = {open: () => {}};
    const sanitizer_mock: any = {};
    const router_mock: any = {navigate: () => {}};
    const route_mock: any = {snapshot: {paramMap: {get: () => null}}};

    component = new SettingsComponent(
      posts_service_mock,
      snack_bar_mock,
      sanitizer_mock,
      dialog_mock,
      router_mock,
      route_mock
    );
  });

  it('opens a confirm dialog', () => {
    component.deleteOrphanFiles();
    expect(dialog_mock.open).toHaveBeenCalled();
  });

  it('calls deleteOrphanFiles on the service when confirmed', () => {
    component.deleteOrphanFiles();
    const dialog_data = dialog_mock.open.calls.mostRecent().args[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.deleteOrphanFiles).toHaveBeenCalled();
  });

  it('does not call the service when the dialog is cancelled', () => {
    component.deleteOrphanFiles();
    const dialog_data = dialog_mock.open.calls.mostRecent().args[1].data;
    dialog_data.doneEmitter.emit(false);
    expect(posts_service_mock.deleteOrphanFiles).not.toHaveBeenCalled();
  });

  it('shows a snackbar with the deleted count on success', () => {
    posts_service_mock.deleteOrphanFiles.and.returnValue(
      of({deleted_count: 5, failed_count: 0})
    );
    component.deleteOrphanFiles();
    const dialog_data = dialog_mock.open.calls.mostRecent().args[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
    const message: string = posts_service_mock.openSnackBar.calls.mostRecent().args[0];
    expect(message).toContain('5');
  });

  it('includes the failed count in the snackbar when some deletions failed', () => {
    posts_service_mock.deleteOrphanFiles.and.returnValue(
      of({deleted_count: 2, failed_count: 1})
    );
    component.deleteOrphanFiles();
    const dialog_data = dialog_mock.open.calls.mostRecent().args[1].data;
    dialog_data.doneEmitter.emit(true);
    const message: string = posts_service_mock.openSnackBar.calls.mostRecent().args[0];
    expect(message).toContain('1');
  });

  it('shows an error snackbar when the API call fails', () => {
    posts_service_mock.deleteOrphanFiles.and.returnValue(throwError(() => new Error('server error')));
    component.deleteOrphanFiles();
    const dialog_data = dialog_mock.open.calls.mostRecent().args[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
    const message: string = posts_service_mock.openSnackBar.calls.mostRecent().args[0];
    expect(message.toLowerCase()).toContain('failed');
  });
});
