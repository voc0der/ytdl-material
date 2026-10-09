import { shareLink, shareLinkAt } from './share-link';

describe('shareLink', () => {
  it('puts the link at the root, beside the API', () => {
    expect(shareLink('https://media.example.com/api/', 'AbCdEf12345')).toBe('https://media.example.com/s/AbCdEf12345');
    // The development server, where the API is on the backend's own port.
    expect(shareLink('http://localhost:17442/api/', 'AbCdEf12345')).toBe('http://localhost:17442/s/AbCdEf12345');
  });

  it('opens at a time in whole seconds, and from the start at none', () => {
    const link = 'https://media.example.com/s/AbCdEf12345';
    expect(shareLinkAt(link, 90.7)).toBe(`${link}?t=90`);
    expect(shareLinkAt(link, 0.4)).toBe(link);
  });
});
