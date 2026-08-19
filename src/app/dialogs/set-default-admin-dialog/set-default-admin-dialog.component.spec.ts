import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { SetDefaultAdminDialogComponent } from './set-default-admin-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SetDefaultAdminDialogComponent', () => {
  let component: SetDefaultAdminDialogComponent;
  let fixture: ComponentFixture<SetDefaultAdminDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ SetDefaultAdminDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SetDefaultAdminDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
