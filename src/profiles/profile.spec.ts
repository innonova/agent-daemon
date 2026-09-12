import { parseProfile, toPublicProfile } from './profile.js';

describe('parseProfile', () => {
  it('applies defaults and the file stem as name', () => {
    const p = parseProfile({ command: 'claude' }, '/x/claude.json', 'claude');
    expect(p).toEqual({
      name: 'claude',
      description: undefined,
      command: 'claude',
      args: [],
      cwd: null,
      env: {},
      loginShell: false,
      file: '/x/claude.json',
    });
    expect(toPublicProfile(p)).not.toHaveProperty('file');
  });

  it('prefers an explicit name', () => {
    expect(parseProfile({ name: 'a', command: 'x' }, '/f.json', 'f').name).toBe(
      'a',
    );
  });

  it.each([
    [null, 'JSON object'],
    [[], 'JSON object'],
    [{}, '"command"'],
    [{ command: '' }, '"command"'],
    [{ command: 'x', args: 'no' }, '"args"'],
    [{ command: 'x', args: [1] }, '"args"'],
    [{ command: 'x', cwd: 1 }, '"cwd"'],
    [{ command: 'x', env: { A: 1 } }, '"env"'],
    [{ command: 'x', env: [] }, '"env"'],
    [{ command: 'x', loginShell: 'yes' }, '"loginShell"'],
    [{ command: 'x', name: '' }, '"name"'],
    [{ command: 'x', description: 1 }, '"description"'],
  ])('rejects %j', (raw, fragment) => {
    expect(() => parseProfile(raw, '/f.json', 'f')).toThrow(fragment);
  });
});
