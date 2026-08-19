import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { UserProfileDialogComponent } from './user-profile-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('UserProfileDialogComponent', () => {
  let component: UserProfileDialogComponent;
  let fixture: ComponentFixture<UserProfileDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ UserProfileDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UserProfileDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
