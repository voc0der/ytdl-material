import { ComponentFixture, TestBed, fakeAsync, tick, waitForAsync } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { CookiesUploaderDialogComponent } from './cookies-uploader-dialog.component';
import { PostsService } from '../../posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('CookiesUploaderDialogComponent', () => {
  let component: CookiesUploaderDialogComponent;
  let fixture: ComponentFixture<CookiesUploaderDialogComponent>;
  let postsService: {
    uploadCookiesFile: ReturnType<typeof vi.fn>;
    testCookies: ReturnType<typeof vi.fn>;
    openSnackBar: ReturnType<typeof vi.fn>;
  };

  const cookiesFile = () => new File(['# Netscape HTTP Cookie File\n'], 'cookies.txt', {type: 'text/plain'});
  const text = () => fixture.nativeElement.textContent as string;

  beforeEach(waitForAsync(() => {
    postsService = {
      uploadCookiesFile: vi.fn().mockReturnValue(of({success: true})),
      testCookies: vi.fn().mockReturnValue(of({success: true, logs: ['Cookie file found.']})),
      openSnackBar: vi.fn()
    };
    configureTestBed({
      imports: [ CookiesUploaderDialogComponent ],
      providers: [{provide: PostsService, useValue: postsService}]
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

  /*************************************************
   * Through ngx-file-drop itself: a drop on its zone
   * and a file picked with the browse button are both
   * turned into entries and handed over once its
   * timer settles. The dialog binds to its output by
   * name, and a renamed output would be taken for a
   * DOM event and simply never fire.
   ************************************************/
  describe('Choosing a file (ngx-file-drop)', () => {
    function drop(file: File) {
      const event = new Event('drop', {bubbles: true, cancelable: true});
      Object.defineProperty(event, 'dataTransfer', {value: {files: [file]}});
      fixture.nativeElement.querySelector('ngx-file-drop > div').dispatchEvent(event);
      tick(200);
      fixture.detectChanges();
      return event;
    }

    it('takes a dropped file, and uploads it under its name', fakeAsync(() => {
      const file = cookiesFile();
      const event = drop(file);

      expect(event.defaultPrevented).toBe(true);
      expect(component.files.map(entry => entry.relativePath)).toEqual(['cookies.txt']);
      expect(text()).toContain('cookies.txt');

      fixture.nativeElement.querySelector('.upload-file button').click();
      fixture.detectChanges();

      expect(postsService.uploadCookiesFile).toHaveBeenCalledWith(file, 'cookies.txt');
      expect(component.uploading).toBe(false);
      expect(component.uploaded).toBe(true);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Cookies successfully uploaded!');
      expect(fixture.nativeElement.querySelector('.upload-file button').disabled).toBe(true);
    }));

    it('takes a file picked with the browse button', fakeAsync(() => {
      const input: HTMLInputElement = fixture.nativeElement.querySelector('ngx-file-drop input[type=file]');
      expect(input.accept).toBe('.txt');
      expect(input.multiple).toBe(false);
      const picker = vi.spyOn(input, 'click').mockImplementation(() => undefined);

      Array.from<HTMLButtonElement>(fixture.nativeElement.querySelectorAll('button'))
        .find(button => button.textContent.includes('Browse Files')).click();
      expect(picker).toHaveBeenCalled();

      Object.defineProperty(input, 'files', {value: [cookiesFile()], configurable: true});
      input.dispatchEvent(new Event('change'));
      tick(200);
      fixture.detectChanges();

      expect(component.files.map(entry => entry.relativePath)).toEqual(['cookies.txt']);
    }));

    it('lets an upload that failed be tried again', fakeAsync(() => {
      postsService.uploadCookiesFile.mockReturnValue(throwError(() => new Error('offline')));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      drop(cookiesFile());

      component.uploadFile();
      fixture.detectChanges();

      expect(component.uploading).toBe(false);
      expect(component.uploaded).toBe(false);
      expect(postsService.openSnackBar).not.toHaveBeenCalled();
      expect(fixture.nativeElement.querySelector('.upload-file button').disabled).toBe(false);
    }));

    it('starts over when another file is dropped', fakeAsync(() => {
      drop(cookiesFile());
      component.uploadFile();
      expect(component.uploaded).toBe(true);

      drop(new File(['x'], 'other.txt'));
      expect(component.files.map(entry => entry.relativePath)).toEqual(['other.txt']);
      expect(component.uploaded).toBe(false);
    }));
  });

  describe('Testing the cookies', () => {
    it('asks for a URL before testing', () => {
      component.cookiesTestUrl = '   ';
      component.runCookiesTest();
      expect(postsService.testCookies).not.toHaveBeenCalled();
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Please provide a URL to test.');
    });

    it('tests the trimmed URL and shows what the server logged', () => {
      component.cookiesTestUrl = '  https://example.com/clip  ';
      component.runCookiesTest();
      fixture.detectChanges();

      expect(postsService.testCookies).toHaveBeenCalledWith('https://example.com/clip');
      expect(component.cookiesTestSuccess).toBe(true);
      expect(component.cookiesTestLogs).toEqual(['Cookie file found.']);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Cookies test passed.');
    });

    it('reports a test that ran and failed', () => {
      postsService.testCookies.mockReturnValue(of({success: false, logs: 'not a list'}));
      component.cookiesTestUrl = 'https://example.com/clip';
      component.runCookiesTest();

      expect(component.cookiesTestComplete).toBe(true);
      expect(component.cookiesTestSuccess).toBe(false);
      expect(component.cookiesTestLogs).toEqual([]);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Cookies test failed. Review the popup logs.');
    });

    it('shows the server\'s logs from a refused test, or says it failed', () => {
      postsService.testCookies.mockReturnValue(throwError(() => ({error: {logs: ['Invalid test URL provided: ftp://x']}})));
      component.cookiesTestUrl = 'ftp://x';
      component.runCookiesTest();
      expect(component.cookiesTestLogs).toEqual(['Invalid test URL provided: ftp://x']);
      expect(component.testingCookies).toBe(false);

      postsService.testCookies.mockReturnValue(throwError(() => ({status: 502})));
      component.runCookiesTest();
      expect(component.cookiesTestLogs).toEqual(['Cookies test failed due to a server error.']);
      expect(component.cookiesTestSuccess).toBe(false);
    });
  });
});
