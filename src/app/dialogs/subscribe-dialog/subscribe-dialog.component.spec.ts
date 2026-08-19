import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { SubscribeDialogComponent } from './subscribe-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SubscribeDialogComponent', () => {
  let component: SubscribeDialogComponent;
  let fixture: ComponentFixture<SubscribeDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ SubscribeDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SubscribeDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
