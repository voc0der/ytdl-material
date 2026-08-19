import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { ManageRoleComponent } from './manage-role.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ManageRoleComponent', () => {
  let component: ManageRoleComponent;
  let fixture: ComponentFixture<ManageRoleComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ ManageRoleComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ManageRoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
