import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';

import { LinkifyPipe, SeeMoreComponent } from './see-more.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SeeMoreComponent', () => {
  let component: SeeMoreComponent;
  let fixture: ComponentFixture<SeeMoreComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ SeeMoreComponent, LinkifyPipe ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SeeMoreComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
