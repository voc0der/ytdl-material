import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConcurrentStreamComponent } from './concurrent-stream.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ConcurrentStreamComponent', () => {
  let component: ConcurrentStreamComponent;
  let fixture: ComponentFixture<ConcurrentStreamComponent>;

  beforeEach(async () => {
    await configureTestBed({
      declarations: [ ConcurrentStreamComponent ]
    })
    .compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(ConcurrentStreamComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
