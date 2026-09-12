import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfilesService } from './profiles.service.js';

describe('ProfilesService', () => {
  let dir: string;
  let svc: ProfilesService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
    fs.mkdirSync(path.join(dir, 'profiles'));
    svc = new ProfilesService({
      host: '127.0.0.1',
      port: 0,
      configDir: dir,
      stateDir: dir,
      maxLineBytes: 1024,
      slowConsumerBytes: 1024,
      pipeGraceMs: 10,
    });
  });

  it('never lets an older reload overwrite a newer one', async () => {
    const write = (args: string[]) =>
      fs.writeFileSync(
        path.join(dir, 'profiles', 'a.json'),
        JSON.stringify({ command: 'x', args }),
      );
    write(['old']);
    // the first reload is slow to read; the second must still win
    const realReaddir = fs.promises.readdir;
    let calls = 0;
    const spy = vi
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(async (...a: any[]) => {
        if (++calls === 1) await new Promise((r) => setTimeout(r, 100));
        return (realReaddir as any)(...a);
      });
    try {
      const first = svc.reload();
      write(['new']);
      const second = svc.reload();
      const [, r2] = await Promise.all([first, second]);
      expect(r2[0].args).toEqual(['new']);
      expect(svc.get('a')!.args).toEqual(['new']);
    } finally {
      spy.mockRestore();
    }
  });
});
