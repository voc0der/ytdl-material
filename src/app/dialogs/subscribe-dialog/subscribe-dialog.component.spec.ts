import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of } from 'rxjs';

import { SubscribeDialogComponent } from './subscribe-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';
import { PostsService } from 'app/posts.services';

describe('SubscribeDialogComponent', () => {
  let component: SubscribeDialogComponent;
  let fixture: ComponentFixture<SubscribeDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ SubscribeDialogComponent ]
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

  it('should include the automatic playlist option when subscribing', () => {
    const postsService = TestBed.inject(PostsService) as any;
    postsService.createSubscription = vi.fn().mockReturnValue(of({new_sub: {id: 'subscription-1'}}));
    component.url = 'https://example.com/channel';
    component.autoCreatePlaylist = true;

    component.subscribeClicked();

    expect(postsService.createSubscription).toHaveBeenCalledWith(
      component.url,
      component.name,
      null,
      component.maxQuality,
      component.audioOnlyMode,
      component.customArgs,
      component.customFileOutput,
      component.useSubfolder,
      true
    );
  });
});
