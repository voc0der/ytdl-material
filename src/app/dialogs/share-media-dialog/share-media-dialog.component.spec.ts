import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { ShareMediaDialogComponent } from './share-media-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ShareMediaDialogComponent', () => {
  let component: ShareMediaDialogComponent;
  let fixture: ComponentFixture<ShareMediaDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ ShareMediaDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ShareMediaDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
