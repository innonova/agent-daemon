import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DAEMON_CONFIG } from '../config/config.js';
import type { DaemonConfig } from '../config/config.js';
import { parseProfile, Profile } from './profile.js';

/**
 * Holds the current profile set. Profiles are templates; nothing here ever
 * touches a running session.
 */
@Injectable()
export class ProfilesService implements OnModuleInit {
  private readonly logger = new Logger(ProfilesService.name);
  private readonly emitter = new EventEmitter();
  private profiles = new Map<string, Profile>();
  private reloading: Promise<Profile[]> = Promise.resolve([]);

  constructor(@Inject(DAEMON_CONFIG) private readonly config: DaemonConfig) {}

  get dir(): string {
    return path.join(this.config.configDir, 'profiles');
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  list(): Profile[] {
    return [...this.profiles.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  get(name: string): Profile | undefined {
    return this.profiles.get(name);
  }

  /** Subscribe to profile set replacements. Returns an unsubscribe function. */
  onChange(listener: (profiles: Profile[]) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  /**
   * Re-reads the profile directory and atomically replaces the set. Files
   * that fail to parse are logged and skipped so one bad file cannot take
   * the others down. A missing directory yields an empty set.
   */
  reload(): Promise<Profile[]> {
    // Reloads are serialised so an older read can never overwrite a newer
    // set: each one starts after the previous has committed.
    const run = this.reloading.then(
      () => this.doReload(),
      () => this.doReload(),
    );
    this.reloading = run;
    return run;
  }

  private async doReload(): Promise<Profile[]> {
    const next = new Map<string, Profile>();
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.dir))
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.logger.warn(
        `profile directory ${this.dir} does not exist; no profiles loaded`,
      );
    }
    for (const entry of entries) {
      const file = path.join(this.dir, entry);
      try {
        const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        const profile = parseProfile(raw, file, path.basename(entry, '.json'));
        if (next.has(profile.name)) {
          this.logger.warn(
            `duplicate profile name "${profile.name}" in ${file}; keeping ${next.get(profile.name)!.file}`,
          );
          continue;
        }
        next.set(profile.name, profile);
      } catch (err) {
        this.logger.warn(`skipping profile ${file}: ${(err as Error).message}`);
      }
    }
    this.profiles = next;
    const list = this.list();
    this.logger.log(`loaded ${list.length} profile(s) from ${this.dir}`);
    this.emitter.emit('change', list);
    return list;
  }
}
