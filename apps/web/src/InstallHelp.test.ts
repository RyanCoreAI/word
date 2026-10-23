import { describe, expect, it } from 'vitest';
import { installPlatform } from './InstallHelp';

describe('installation instructions', () => {
  it('prioritizes embedded-browser limitations over the underlying Android platform', () => {
    expect(installPlatform('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile MicroMessenger/8.0')).toBe('embedded');
    expect(installPlatform('Mozilla/5.0 (Linux; Android 15) Mobile QQ/9.0')).toBe('embedded');
    expect(installPlatform('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile')).toBe('android');
  });
  it('keeps Safari and desktop instructions separate', () => {
    expect(installPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1')).toBe('ios');
    expect(installPlatform('Mozilla/5.0 (Windows NT 10.0) Chrome/130')).toBe('desktop');
  });
});
