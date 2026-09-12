import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses documented defaults', () => {
    const c = loadConfig({ HOME: '/home/u' });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(4267);
    expect(c.maxLineBytes).toBe(10 * 1024 * 1024);
    expect(c.configDir.endsWith('/.config/agent-daemon')).toBe(true);
    expect(c.stateDir.endsWith('/.local/state/agent-daemon')).toBe(true);
  });

  it('parses AGENT_DAEMON_LISTEN', () => {
    expect(loadConfig({ AGENT_DAEMON_LISTEN: '0.0.0.0:80' })).toMatchObject({
      host: '0.0.0.0',
      port: 80,
    });
    expect(loadConfig({ AGENT_DAEMON_LISTEN: '9000' })).toMatchObject({
      host: '127.0.0.1',
      port: 9000,
    });
    expect(() => loadConfig({ AGENT_DAEMON_LISTEN: 'x:abc' })).toThrow(
      'invalid port',
    );
  });

  it('honours directory and limit overrides', () => {
    const c = loadConfig({
      AGENT_DAEMON_CONFIG_DIR: '/c',
      AGENT_DAEMON_STATE_DIR: '/s',
      AGENT_DAEMON_MAX_LINE: '100',
    });
    expect(c).toMatchObject({
      configDir: '/c',
      stateDir: '/s',
      maxLineBytes: 100,
    });
    expect(() => loadConfig({ AGENT_DAEMON_MAX_LINE: '0' })).toThrow(
      'positive',
    );
  });
});
