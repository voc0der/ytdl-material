import { fileThumbnailURL } from './file-display';

describe('fileThumbnailURL', () => {
  it('asks the thumbnail endpoint for art the server holds, by the file\'s uid', () => {
    expect(fileThumbnailURL({uid: 'a b', thumbnailPath: 'video/a.jpg'}, '/api/')).toBe('/api/thumbnail/a%20b');
  });

  it('carries the token and the shared library in the query, as an <img> sends no header', () => {
    expect(fileThumbnailURL({uid: 'f1', thumbnailPath: 'video/f1.jpg'}, '/api', 'token', 'bob'))
      .toBe('/api/thumbnail/f1?jwt=token&library=bob');
  });

  it('gives art made again a new address, so the old is not shown from the cache', () => {
    expect(fileThumbnailURL({uid: 'f1', thumbnailPath: 'video/f1.webp', thumbnail_updated_at: 1700000000000}, '/api', 'token'))
      .toBe('/api/thumbnail/f1?jwt=token&v=1700000000000');
  });

  it('falls back to the site\'s art, and to none', () => {
    expect(fileThumbnailURL({uid: 'f1', thumbnailURL: 'https://images.example.test/f1.jpg'}, '/api'))
      .toBe('https://images.example.test/f1.jpg');
    expect(fileThumbnailURL({uid: 'f1'}, '/api')).toBeNull();
    expect(fileThumbnailURL(null, '/api')).toBeNull();
  });
});
