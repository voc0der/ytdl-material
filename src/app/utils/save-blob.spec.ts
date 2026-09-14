import { OBJECT_URL_REVOKE_DELAY_MS, saveBlob } from './save-blob';

describe('saveBlob', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let originals: { create: typeof URL.createObjectURL; revoke: typeof URL.revokeObjectURL };

  beforeEach(() => {
    vi.useFakeTimers();
    originals = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    createObjectURL = vi.fn(() => 'blob:test-url');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = originals.create;
    URL.revokeObjectURL = originals.revoke;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clicks a download link for the blob and removes it', () => {
    const blob = new Blob(['data'], { type: 'text/plain' });
    let connectedWhenClicked = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      connectedWhenClicked = this.isConnected;
    });

    saveBlob(blob, 'archive.txt');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    const clicked = click.mock.contexts[0] as HTMLAnchorElement;
    expect(connectedWhenClicked).toBe(true);
    expect(clicked.href).toBe('blob:test-url');
    expect(clicked.download).toBe('archive.txt');
    expect(clicked.isConnected).toBe(false);
  });

  it('revokes the object URL only after the delay', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    saveBlob(new Blob(['data']), 'video.mp4');

    vi.advanceTimersByTime(OBJECT_URL_REVOKE_DELAY_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });
});
