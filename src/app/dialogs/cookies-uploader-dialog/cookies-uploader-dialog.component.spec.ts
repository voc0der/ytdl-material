import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { CookiesUploaderDialogComponent } from './cookies-uploader-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('CookiesUploaderDialogComponent', () => {
  let component: CookiesUploaderDialogComponent;
  let fixture: ComponentFixture<CookiesUploaderDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ CookiesUploaderDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(CookiesUploaderDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
