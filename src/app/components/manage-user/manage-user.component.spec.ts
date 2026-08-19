import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { ManageUserComponent } from './manage-user.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ManageUserComponent', () => {
  let component: ManageUserComponent;
  let fixture: ComponentFixture<ManageUserComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ ManageUserComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ManageUserComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
