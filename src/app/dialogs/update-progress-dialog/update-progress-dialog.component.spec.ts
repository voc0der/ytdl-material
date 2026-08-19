import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { UpdateProgressDialogComponent } from './update-progress-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('UpdateProgressDialogComponent', () => {
  let component: UpdateProgressDialogComponent;
  let fixture: ComponentFixture<UpdateProgressDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ UpdateProgressDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UpdateProgressDialogComponent);
    component = fixture.componentInstance;
    component.updateStatus = { updating: false } as any;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
