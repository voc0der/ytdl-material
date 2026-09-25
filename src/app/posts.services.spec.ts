import { OWN_LIBRARY_PAGES, PostsService } from './posts.services';

describe('PostsService route guard while browsing someone else\'s library', () => {
  const guard = (path: string, service: any) =>
    PostsService.prototype._canActivate.call(service, { routeConfig: { path } } as any);

  let service: any;

  beforeEach(() => {
    service = { hasPermission: vi.fn().mockReturnValue(true), viewLibrary: vi.fn() };
  });

  it.each(OWN_LIBRARY_PAGES)('goes back to your own library before opening %s', async path => {
    expect(await guard(path, service)).toBe(true);
    expect(service.viewLibrary).toHaveBeenCalledWith(null);
  });

  it.each(['home', 'player', 'settings', 'tasks'])('stays in the library you are browsing on %s', async path => {
    expect(await guard(path, service)).toBe(true);
    expect(service.viewLibrary).not.toHaveBeenCalled();
  });

  it('still refuses a page you have no permission for', async () => {
    service.hasPermission.mockReturnValue(false);

    expect(await guard('downloads', service)).toBe(false);
    expect(service.hasPermission).toHaveBeenCalledWith('downloads_manager');
  });
});
