import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { SubscriptionInfoDialogComponent } from './subscription-info-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SubscriptionInfoDialogComponent', () => {
  let component: SubscriptionInfoDialogComponent;
  let fixture: ComponentFixture<SubscriptionInfoDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ SubscriptionInfoDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SubscriptionInfoDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
