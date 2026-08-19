import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { EditSubscriptionDialogComponent } from './edit-subscription-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('EditSubscriptionDialogComponent', () => {
  let component: EditSubscriptionDialogComponent;
  let fixture: ComponentFixture<EditSubscriptionDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ EditSubscriptionDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(EditSubscriptionDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
