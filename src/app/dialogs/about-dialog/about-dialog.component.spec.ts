import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { AboutDialogComponent } from './about-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('AboutDialogComponent', () => {
  let component: AboutDialogComponent;
  let fixture: ComponentFixture<AboutDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ AboutDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(AboutDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
