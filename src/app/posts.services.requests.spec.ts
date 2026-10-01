import { HttpParams, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { firstValueFrom, Observable } from 'rxjs';

import { FileType, UserPermission, YesNo } from '../api-types';
import { PostsService } from './posts.services';

const API = 'http://localhost/api/';

interface ExpectedRequest {
  call: string;
  send: (service: PostsService) => Observable<unknown>;
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  blob?: boolean;
}

// Every request the pages make through the service, with the route, method and body the
// backend's handler for it reads. Grouped the way the backend groups its routes.
const REQUESTS: ExpectedRequest[] = [
  // Downloading
  {call: 'downloadFile', send: s => s.downloadFile('https://example.com/a', FileType.VIDEO, '720', null, '--a', '--b', '%(id)s', 'name', 'pass', null, true, true, 'en', 'de', 'manual'),
    method: 'POST', url: 'downloadFile', body: {url: 'https://example.com/a', maxHeight: '720', customQualityConfiguration: null, customArgs: '--a', additionalArgs: '--b',
      customOutput: '%(id)s', youtubeUsername: 'name', youtubePassword: 'pass', type: 'video', cropFileSettings: null, disableSponsorBlock: true,
      channelSearchPlaylist: true, selectedAudioLanguage: 'en', selectedSubtitleLanguage: 'de', selectedSubtitleType: 'manual'}},
  {call: 'generateArgs', send: s => s.generateArgs('https://example.com/a', FileType.AUDIO, 'best', null),
    method: 'POST', url: 'generateArgs', body: {url: 'https://example.com/a', maxHeight: 'best', customQualityConfiguration: null, customArgs: null, additionalArgs: null,
      customOutput: null, youtubeUsername: null, youtubePassword: null, type: 'audio', cropFileSettings: null, disableSponsorBlock: false,
      selectedAudioLanguage: null, selectedSubtitleLanguage: null, selectedSubtitleType: null}},
  {call: 'getFileFormats', send: s => s.getFileFormats('https://example.com/a'), method: 'POST', url: 'getFileFormats', body: {url: 'https://example.com/a'}},
  {call: 'searchVideos', send: s => s.searchVideos('cats'), method: 'POST', url: 'searchVideos', body: {query: 'cats'}},
  {call: 'killAllDownloads', send: s => s.killAllDownloads(), method: 'POST', url: 'killAllDownloads', body: {}},

  // The library
  {call: 'getMp3s', send: s => s.getMp3s(), method: 'GET', url: 'getMp3s'},
  {call: 'getMp4s', send: s => s.getMp4s(), method: 'GET', url: 'getMp4s'},
  {call: 'getFile', send: s => s.getFile('file-1', 'owner-1'), method: 'POST', url: 'getFile', body: {uid: 'file-1', uuid: 'owner-1'}},
  {call: 'getAllFiles', send: s => s.getAllFiles({by: 'registered', order: -1}, [0, 10], 'cats'), method: 'POST', url: 'getAllFiles',
    body: {sort: {by: 'registered', order: -1}, range: [0, 10], text_search: 'cats', file_type_filter: 'both', favorite_filter: false, sub_id: null,
      include_chapters: false, category_filter_uids: null}},
  {call: 'updateFile', send: s => s.updateFile('file-1', {title: 'New'}), method: 'POST', url: 'updateFile', body: {uid: 'file-1', change_obj: {title: 'New'}}},
  {call: 'deleteFile', send: s => s.deleteFile('file-1', true), method: 'POST', url: 'deleteFile', body: {uid: 'file-1', blacklistMode: true}},
  {call: 'deleteOrphanFiles', send: s => s.deleteOrphanFiles(), method: 'POST', url: 'deleteOrphanFiles', body: {}},
  {call: 'generateThumbnail', send: s => s.generateThumbnail('file-1', 12), method: 'POST', url: 'generateThumbnail', body: {uid: 'file-1', timestamp_seconds: 12}},
  {call: 'snipFile', send: s => s.snipFile('file-1', 1, 5), method: 'POST', url: 'snipFile', body: {uid: 'file-1', start: 1, end: 5}},
  {call: 'getSnipStatus', send: s => s.getSnipStatus('job-1'), method: 'POST', url: 'getSnipStatus', body: {job_uid: 'job-1'}},
  {call: 'getDuplicateSummary', send: s => s.getDuplicateSummary(), method: 'POST', url: 'getDuplicateSummary', body: {}},
  {call: 'getDuplicates', send: s => s.getDuplicates(), method: 'POST', url: 'getDuplicates', body: {}},
  {call: 'removeNewestDuplicates', send: s => s.removeNewestDuplicates('Generic:1:video'), method: 'POST', url: 'removeDuplicates',
    body: {duplicate_key: 'Generic:1:video', removal_mode: 'newest'}},
  {call: 'incrementViewCount', send: s => s.incrementViewCount('file-1', 'sub-1', 'owner-1', 'playlist-1'), method: 'POST', url: 'incrementViewCount',
    body: {file_uid: 'file-1', sub_id: 'sub-1', uuid: 'owner-1', playlist_id: 'playlist-1'}},
  {call: 'enableSharing', send: s => s.enableSharing('file-1', false), method: 'POST', url: 'enableSharing', body: {uid: 'file-1', is_playlist: false}},
  {call: 'disableSharing', send: s => s.disableSharing('playlist-1', true), method: 'POST', url: 'disableSharing', body: {uid: 'playlist-1', is_playlist: true}},
  {call: 'checkConcurrentStream', send: s => s.checkConcurrentStream('file-1'), method: 'POST', url: 'checkConcurrentStream', body: {uid: 'file-1'}},
  {call: 'updateConcurrentStream', send: s => s.updateConcurrentStream('file-1', 30, 1700000000, true), method: 'POST', url: 'updateConcurrentStream',
    body: {uid: 'file-1', playback_timestamp: 30, unix_timestamp: 1700000000, playing: true}},
  {call: 'getFullTwitchChat', send: s => s.getFullTwitchChat('file-1', 'video'), method: 'POST', url: 'getFullTwitchChat', body: {id: 'file-1', type: 'video', uuid: null, sub: null}},
  {call: 'downloadTwitchChat', send: s => s.downloadTwitchChat('file-1', 'video', 'vod-1'), method: 'POST', url: 'downloadTwitchChatByVODID',
    body: {id: 'file-1', type: 'video', vodId: 'vod-1', uuid: null, sub: null}},

  // Files sent back as downloads
  {call: 'downloadFileFromServer', send: s => s.downloadFileFromServer('file-1'), method: 'POST', url: 'downloadFileFromServer', body: {uid: 'file-1', uuid: null}, blob: true},
  {call: 'downloadPlaylistFromServer', send: s => s.downloadPlaylistFromServer('playlist-1'), method: 'POST', url: 'downloadFileFromServer',
    body: {uuid: null, playlist_id: 'playlist-1'}, blob: true},
  {call: 'downloadSubFromServer', send: s => s.downloadSubFromServer('sub-1'), method: 'POST', url: 'downloadFileFromServer', body: {uuid: null, sub_id: 'sub-1'}, blob: true},
  {call: 'downloadArchive', send: s => s.downloadArchive(FileType.AUDIO, null), method: 'POST', url: 'downloadArchive', body: {type: 'audio', sub_id: null}, blob: true},

  // Playlists and categories
  {call: 'createPlaylist', send: s => s.createPlaylist('Mix', ['file-1'], null), method: 'POST', url: 'createPlaylist', body: {playlistName: 'Mix', uids: ['file-1'], thumbnailURL: null}},
  {call: 'getPlaylist', send: s => s.getPlaylist('playlist-1', null, true), method: 'POST', url: 'getPlaylist', body: {playlist_id: 'playlist-1', include_file_metadata: true, uuid: null}},
  {call: 'getPlaylists', send: s => s.getPlaylists(true), method: 'POST', url: 'getPlaylists', body: {include_categories: true}},
  {call: 'updatePlaylist', send: s => s.updatePlaylist({id: 'playlist-1'} as any), method: 'POST', url: 'updatePlaylist', body: {playlist: {id: 'playlist-1'}}},
  {call: 'removePlaylist', send: s => s.removePlaylist('playlist-1', true), method: 'POST', url: 'deletePlaylist', body: {playlist_id: 'playlist-1', delete_files: true}},
  {call: 'addFileToPlaylist', send: s => s.addFileToPlaylist('playlist-1', 'file-1'), method: 'POST', url: 'addFileToPlaylist', body: {playlist_id: 'playlist-1', file_uid: 'file-1'}},
  {call: 'getAllCategories', send: s => s.getAllCategories(), method: 'POST', url: 'getAllCategories', body: {}},
  {call: 'createCategory', send: s => s.createCategory('Music'), method: 'POST', url: 'createCategory', body: {name: 'Music'}},
  {call: 'createDefaultCategories', send: s => s.createDefaultCategories(), method: 'POST', url: 'createDefaultCategories', body: {}},
  {call: 'deleteCategory', send: s => s.deleteCategory('category-1'), method: 'POST', url: 'deleteCategory', body: {category_uid: 'category-1'}},
  {call: 'updateCategory', send: s => s.updateCategory({uid: 'category-1'}), method: 'POST', url: 'updateCategory', body: {category: {uid: 'category-1'}}},
  {call: 'updateCategories', send: s => s.updateCategories([]), method: 'POST', url: 'updateCategories', body: {categories: []}},

  // Subscriptions
  {call: 'createSubscription', send: s => s.createSubscription('https://example.com/c', 'Channel', 'now-7days', '720', true, '--x', '%(title)s', false, true, true),
    method: 'POST', url: 'subscribe', body: {url: 'https://example.com/c', name: 'Channel', timerange: 'now-7days', maxQuality: '720', audioOnly: true,
      customArgs: '--x', customFileOutput: '%(title)s', useSubfolder: false, autoCreatePlaylist: true, retrieveChannelPlaylists: true}},
  {call: 'checkSubscription', send: s => s.checkSubscription('sub-1'), method: 'POST', url: 'checkSubscription', body: {sub_id: 'sub-1'}},
  {call: 'redownloadSubscription', send: s => s.redownloadSubscription('sub-1'), method: 'POST', url: 'redownloadSubscription', body: {sub_id: 'sub-1'}},
  {call: 'cancelCheckSubscription', send: s => s.cancelCheckSubscription('sub-1'), method: 'POST', url: 'cancelCheckSubscription', body: {sub_id: 'sub-1'}},
  {call: 'unsubscribe', send: s => s.unsubscribe('sub-1', true), method: 'POST', url: 'unsubscribe', body: {sub_id: 'sub-1', deleteMode: true}},
  {call: 'deleteSubscriptionFile', send: s => s.deleteSubscriptionFile('file-1', true), method: 'POST', url: 'deleteSubscriptionFile', body: {file_uid: 'file-1', deleteForever: true}},
  {call: 'getSubscription', send: s => s.getSubscription('sub-1', null, false), method: 'POST', url: 'getSubscription', body: {id: 'sub-1', name: null, include_videos: false}},
  {call: 'getAllSubscriptions', send: s => s.getAllSubscriptions(), method: 'POST', url: 'getSubscriptions', body: {}},

  // The downloads page
  {call: 'getCurrentDownloads', send: s => s.getCurrentDownloads(), method: 'POST', url: 'downloads', body: {uids: null, only_unfinished: false}},
  {call: 'getCurrentDownload', send: s => s.getCurrentDownload('download-1'), method: 'POST', url: 'download', body: {download_uid: 'download-1'}},
  {call: 'pauseDownload', send: s => s.pauseDownload('download-1'), method: 'POST', url: 'pauseDownload', body: {download_uid: 'download-1'}},
  {call: 'pauseAllDownloads', send: s => s.pauseAllDownloads(), method: 'POST', url: 'pauseAllDownloads', body: {}},
  {call: 'resumeDownload', send: s => s.resumeDownload('download-1'), method: 'POST', url: 'resumeDownload', body: {download_uid: 'download-1'}},
  {call: 'resumeAllDownloads', send: s => s.resumeAllDownloads(), method: 'POST', url: 'resumeAllDownloads', body: {}},
  {call: 'restartDownload', send: s => s.restartDownload('download-1'), method: 'POST', url: 'restartDownload', body: {download_uid: 'download-1'}},
  {call: 'cancelDownload', send: s => s.cancelDownload('download-1'), method: 'POST', url: 'cancelDownload', body: {download_uid: 'download-1'}},
  {call: 'clearDownload', send: s => s.clearDownload('download-1'), method: 'POST', url: 'clearDownload', body: {download_uid: 'download-1'}},
  {call: 'clearDownloads', send: s => s.clearDownloads(true, false, true), method: 'POST', url: 'clearDownloads', body: {clear_finished: true, clear_paused: false, clear_errors: true}},

  // Tasks
  {call: 'getTasks', send: s => s.getTasks(), method: 'POST', url: 'getTasks', body: {}},
  {call: 'resetTasks', send: s => s.resetTasks(), method: 'POST', url: 'resetTasks', body: {}},
  {call: 'getTask', send: s => s.getTask('backup_local_db' as any), method: 'POST', url: 'getTask', body: {task_key: 'backup_local_db'}},
  {call: 'runTask', send: s => s.runTask('backup_local_db' as any), method: 'POST', url: 'runTask', body: {task_key: 'backup_local_db'}},
  {call: 'confirmTask', send: s => s.confirmTask('backup_local_db' as any), method: 'POST', url: 'confirmTask', body: {task_key: 'backup_local_db'}},
  {call: 'dismissTaskError', send: s => s.dismissTaskError('backup_local_db' as any), method: 'POST', url: 'dismissTaskError', body: {task_key: 'backup_local_db'}},
  {call: 'updateTaskSchedule', send: s => s.updateTaskSchedule('backup_local_db' as any, null), method: 'POST', url: 'updateTaskSchedule',
    body: {task_key: 'backup_local_db', new_schedule: null}},
  {call: 'updateTaskData', send: s => s.updateTaskData('backup_local_db' as any, {a: 1}), method: 'POST', url: 'updateTaskData', body: {task_key: 'backup_local_db', new_data: {a: 1}}},
  {call: 'updateTaskOptions', send: s => s.updateTaskOptions('backup_local_db' as any, {b: 2}), method: 'POST', url: 'updateTaskOptions',
    body: {task_key: 'backup_local_db', new_options: {b: 2}}},

  // Administration
  {call: 'setConfig', send: s => s.setConfig({YtdlMaterial: {}}), method: 'POST', url: 'setConfig', body: {new_config_file: {YtdlMaterial: {}}}},
  {call: 'restartServer', send: s => s.restartServer(), method: 'POST', url: 'restartServer', body: {}},
  {call: 'getDBInfo', send: s => s.getDBInfo(), method: 'GET', url: 'getDBInfo'},
  {call: 'transferDB', send: s => s.transferDB(true), method: 'POST', url: 'transferDB', body: {local_to_remote: true}},
  {call: 'testConnectionString', send: s => s.testConnectionString('redis://cache:6379'), method: 'POST', url: 'testConnectionString', body: {connection_string: 'redis://cache:6379'}},
  {call: 'getDBBackups', send: s => s.getDBBackups(), method: 'POST', url: 'getDBBackups', body: {}},
  {call: 'restoreDBBackup', send: s => s.restoreDBBackup('local_db.json.1.2.bak'), method: 'POST', url: 'restoreDBBackup', body: {file_name: 'local_db.json.1.2.bak'}},
  {call: 'getLogs', send: s => s.getLogs(), method: 'POST', url: 'logs', body: {lines: 50}},
  {call: 'clearAllLogs', send: s => s.clearAllLogs(), method: 'POST', url: 'clearAllLogs', body: {}},
  {call: 'testCookies', send: s => s.testCookies('https://example.com/a'), method: 'POST', url: 'testCookies', body: {url: 'https://example.com/a'}},
  {call: 'getArchives', send: s => s.getArchives(FileType.VIDEO), method: 'POST', url: 'getArchives', body: {type: 'video', sub_id: null}},
  {call: 'importArchive', send: s => s.importArchive('data:text/plain;base64,eA==', FileType.VIDEO), method: 'POST', url: 'importArchive',
    body: {archive: 'data:text/plain;base64,eA==', type: 'video', sub_id: null}},
  {call: 'deleteArchiveItems', send: s => s.deleteArchiveItems([]), method: 'POST', url: 'deleteArchiveItems', body: {archives: []}},
  {call: 'getVersionInfo', send: s => s.getVersionInfo(), method: 'GET', url: 'versionInfo'},
  {call: 'updateServer', send: s => s.updateServer('v1.2.3'), method: 'POST', url: 'updateServer', body: {tag: 'v1.2.3'}},
  {call: 'getUpdaterStatus', send: s => s.getUpdaterStatus(), method: 'GET', url: 'updaterStatus'},

  // Accounts
  {call: 'register', send: s => s.register('alice', 'secret'), method: 'POST', url: 'auth/register', body: {userid: 'alice', username: 'alice', password: 'secret'}},
  {call: 'createAdminAccount', send: s => s.createAdminAccount('secret'), method: 'POST', url: 'auth/register', body: {userid: 'admin', username: 'admin', password: 'secret'}},
  {call: 'adminExists', send: s => s.adminExists(), method: 'POST', url: 'auth/adminExists', body: {}},
  {call: 'getOIDCStatus', send: s => s.getOIDCStatus(), method: 'GET', url: 'auth/oidc/status'},
  {call: 'changeUser', send: s => s.changeUser({uid: 'bob', name: 'Robert'}), method: 'POST', url: 'updateUser', body: {change_object: {uid: 'bob', name: 'Robert'}}},
  {call: 'deleteUser', send: s => s.deleteUser('bob'), method: 'POST', url: 'deleteUser', body: {uid: 'bob'}},
  {call: 'changeUserPassword', send: s => s.changeUserPassword('bob', 'new', 'old'), method: 'POST', url: 'auth/changePassword',
    body: {user_uid: 'bob', new_password: 'new', current_password: 'old'}},
  {call: 'getUsers', send: s => s.getUsers(), method: 'POST', url: 'getUsers', body: {}},
  {call: 'getRoles', send: s => s.getRoles(), method: 'POST', url: 'getRoles', body: {}},
  {call: 'setUserPermission', send: s => s.setUserPermission('bob', UserPermission.FILEMANAGER, 'default'), method: 'POST', url: 'changeUserPermissions',
    body: {user_uid: 'bob', permission: 'filemanager', new_value: 'default'}},
  {call: 'setRolePermission', send: s => s.setRolePermission('user', UserPermission.SHARING, YesNo.NO), method: 'POST', url: 'changeRolePermissions',
    body: {role: 'user', permission: 'sharing', new_value: 'no'}},
  {call: 'listAPITokens', send: s => s.listAPITokens(), method: 'POST', url: 'listAPITokens', body: {}},
  {call: 'generateAPIToken', send: s => s.generateAPIToken('scripts', 'rss'), method: 'POST', url: 'generateAPIToken', body: {label: 'scripts', type: 'rss'}},
  {call: 'revokeAPIToken', send: s => s.revokeAPIToken('token-1'), method: 'POST', url: 'revokeAPIToken', body: {token_id: 'token-1'}},
  {call: 'getSharedLibraries', send: s => s.getSharedLibraries(), method: 'POST', url: 'getSharedLibraries', body: {}},
  {call: 'setLibrarySharing', send: s => s.setLibrarySharing(true), method: 'POST', url: 'setLibrarySharing', body: {enabled: true}},

  // Notifications
  {call: 'getNotifications', send: s => s.getNotifications(), method: 'POST', url: 'getNotifications', body: {}},
  {call: 'setNotificationsToRead', send: s => s.setNotificationsToRead(['note-1']), method: 'POST', url: 'setNotificationsToRead', body: {uids: ['note-1']}},
  {call: 'deleteNotification', send: s => s.deleteNotification('note-1'), method: 'POST', url: 'deleteNotification', body: {uid: 'note-1'}},
  {call: 'deleteAllNotifications', send: s => s.deleteAllNotifications(), method: 'POST', url: 'deleteAllNotifications', body: {}}
];

/*************************************************
 * What the web app actually puts on the wire for
 * each backend route, through Angular's HttpClient:
 * the method, the URL, the body the route reads,
 * and which responses come back as files.
 ************************************************/
describe('PostsService requests', () => {
  let service: PostsService;
  let http: HttpTestingController;

  const config = (multi_user_mode: boolean) => ({
    config_file: {YtdlMaterial: {Advanced: {multi_user_mode}, Extra: {title_top: 'Media library'}, Users: {oidc: {enabled: false}}}},
    success: true
  });

  function start(multi_user_mode = false) {
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(PostsService);
    http.expectOne(API + 'config').flush(config(multi_user_mode));
  }

  // A saved session: the token is checked, then the config fetched again with it.
  function startSignedIn() {
    localStorage.setItem('jwt_token', 'session-token');
    start(true);
    http.expectOne(request => request.url === API + 'auth/jwtAuth').flush({
      user: {uid: 'alice'}, token: 'session-token', permissions: [], available_permissions: []
    });
    http.expectOne(request => request.url === API + 'config').flush(config(true));
  }

  beforeEach(() => {
    // Talk to /api rather than the bundled development config.
    vi.stubGlobal('ngDevMode', false);
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        PostsService, provideHttpClient(), provideHttpClientTesting(),
        {provide: Router, useValue: {url: '/home', navigate: vi.fn().mockResolvedValue(true), navigateByUrl: vi.fn().mockResolvedValue(true)}},
        {provide: MatSnackBar, useValue: {open: vi.fn()}},
        {provide: Title, useValue: {setTitle: vi.fn()}}
      ]
    });
  });

  afterEach(() => {
    try {
      http?.verify();
    } finally {
      localStorage.clear();
      vi.unstubAllGlobals();
    }
  });

  it.each(REQUESTS)('$call sends $method /api/$url', async ({send, method, url, body, blob}) => {
    start();
    const response = firstValueFrom(send(service));

    const request = http.expectOne(API + url);
    expect(request.request.method).toBe(method);
    if (method === 'POST') expect(request.request.body).toEqual(body);
    expect(request.request.responseType).toBe(blob ? 'blob' : 'json');
    expect(request.request.params.keys()).toEqual([]);

    request.flush(blob ? new Blob(['file']) : {success: true});
    const result = await response;
    if (blob) expect(result).toBeInstanceOf(Blob);
  });

  it('signs every request with the session token in multi-user mode', async () => {
    startSignedIn();

    const response = firstValueFrom(service.getMp4s());
    const request = http.expectOne(request => request.url === API + 'getMp4s');
    expect(request.request.params.get('jwt')).toBe('session-token');
    request.flush({mp4s: [], playlists: []});
    await response;

    const download = firstValueFrom(service.downloadFileFromServer('file-1'));
    const file_request = http.expectOne(request => request.url === API + 'downloadFileFromServer');
    expect(file_request.request.params.get('jwt')).toBe('session-token');
    file_request.flush(new Blob(['file']));
    await download;
  });

  it('asks for someone else\'s library only on the reads that can answer from one', async () => {
    start();
    const reads: [string, Observable<unknown>][] = [
      ['getFile', service.getFile('file-1', null, 'alice')],
      ['getAllFiles', service.getAllFiles(null, null, null, undefined, false, null, false, null, 'alice')],
      ['getPlaylist', service.getPlaylist('playlist-1', null, false, 'alice')],
      ['getPlaylists', service.getPlaylists(false, 'alice')]
    ];
    for (const [url, read] of reads) {
      const response = firstValueFrom(read);
      const request = http.expectOne(request => request.url === API + url);
      expect(request.request.params.get('library')).toBe('alice');
      request.flush({success: true});
      await response;
    }

    // And only when one is named.
    const own = firstValueFrom(service.getFile('file-1'));
    const own_request = http.expectOne(request => request.url === API + 'getFile');
    expect(own_request.request.params.has('library')).toBe(false);
    own_request.flush({success: true});
    await own;
  });

  it('uploads cookies as a multipart form under the field the server reads', async () => {
    start();
    const file = new File(['# Netscape HTTP Cookie File'], 'cookies.txt', {type: 'text/plain'});
    const response = firstValueFrom(service.uploadCookiesFile(file, 'cookies.txt'));

    const request = http.expectOne(API + 'uploadCookies');
    expect(request.request.method).toBe('POST');
    const form = request.request.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('cookies') as File).name).toBe('cookies.txt');
    expect(await (form.get('cookies') as File).text()).toBe('# Netscape HTTP Cookie File');
    request.flush({success: true});
    await response;
  });

  it('pages the downloads list only when a page is asked for', async () => {
    start();
    const response = firstValueFrom(service.getCurrentDownloads(['download-1'], true, 2, 25));
    const request = http.expectOne(API + 'downloads');
    expect(request.request.body).toEqual({uids: ['download-1'], only_unfinished: true, page: 2, page_size: 25});
    request.flush({downloads: []});
    await response;
  });

  it('leaves the file list out of a saved subscription', async () => {
    start();
    const subscription = {id: 'sub-1', name: 'Channel', videos: [{uid: 'file-1'}]};
    const response = firstValueFrom(service.updateSubscription(subscription));
    const request = http.expectOne(API + 'updateSubscription');
    expect(request.request.body).toEqual({subscription: {id: 'sub-1', name: 'Channel'}});
    request.flush({success: true});
    await response;
  });

  it('keeps the categories it reloads, and says so', async () => {
    start();
    const changed = vi.fn();
    service.categories_changed.subscribe(changed);
    service.reloadCategories();
    http.expectOne(API + 'getAllCategories').flush({categories: [{uid: 'category-1', name: 'Music'}]});
    expect(service.categories).toEqual([{uid: 'category-1', name: 'Music'}]);
    expect(changed).toHaveBeenCalledWith(true);
  });

  it('keeps the subscriptions it reloads', () => {
    start();
    service.reloadSubscriptions();
    http.expectOne(API + 'getSubscriptions').flush({subscriptions: [{id: 'sub-1'}]});
    expect(service.subscriptions).toEqual([{id: 'sub-1'}]);
  });

  it('checks a playback link with a HEAD, outside the session', async () => {
    startSignedIn();

    const link = firstValueFrom(service.createPlaybackLink('file-1', true));
    const create = http.expectOne(request => request.url === API + 'createPlaybackLink');
    expect(create.request.body).toEqual({uid: 'file-1', transcode: true});
    create.flush({url: 'http://localhost/api/stream?token=abc'});
    await link;

    const check = firstValueFrom(service.checkPlaybackLink('http://localhost/api/stream?token=abc'));
    const head = http.expectOne('http://localhost/api/stream?token=abc');
    expect(head.request.method).toBe('HEAD');
    expect(head.request.params).toEqual(new HttpParams());
    head.flush(null, {status: 503, statusText: 'Service Unavailable'});
    await expect(check).rejects.toMatchObject({status: 503});
  });

  it('builds the OIDC login link with the page to return to', () => {
    start();
    expect(service.getOIDCLoginURL('/player;uid=file 1')).toBe(API + 'auth/oidc/login?returnTo=%2Fplayer%3Buid%3Dfile%201');
    expect(service.getOIDCLoginURL()).toBe(API + 'auth/oidc/login?returnTo=%2Fhome');
  });

  it('reads release information from the project\'s releases', async () => {
    start();
    const latest = firstValueFrom(service.getLatestGithubRelease());
    http.expectOne('https://api.github.com/repos/voc0der/ytdl-material/releases/latest').flush({tag_name: 'v1.2.3'});
    expect(await latest).toEqual({tag_name: 'v1.2.3'});

    const all = firstValueFrom(service.getAvailableRelease());
    http.expectOne('https://api.github.com/repos/voc0der/ytdl-material/releases').flush([]);
    expect(await all).toEqual([]);
  });

  it('loads bundled assets relative to the page', async () => {
    start();
    const locales = firstValueFrom(service.getSupportedLocales());
    http.expectOne('./assets/i18n/supported_locales.json').flush(['en']);
    expect(await locales).toEqual(['en']);

    const asset = firstValueFrom(service.loadAsset('default.json'));
    http.expectOne('./assets/default.json').flush({});
    await asset;
  });
});
