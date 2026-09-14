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
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
      expect(this.isConnected).toBe(true);
    });

    saveBlob(blob, 'archive.txt');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).not.toBeNull();
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
