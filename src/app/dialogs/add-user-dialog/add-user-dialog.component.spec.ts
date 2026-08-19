import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { AddUserDialogComponent } from './add-user-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('AddUserDialogComponent', () => {
  let component: AddUserDialogComponent;
  let fixture: ComponentFixture<AddUserDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ AddUserDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(AddUserDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
