import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { ModifyUsersComponent } from './modify-users.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ModifyUsersComponent', () => {
  let component: ModifyUsersComponent;
  let fixture: ComponentFixture<ModifyUsersComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ ModifyUsersComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ModifyUsersComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
