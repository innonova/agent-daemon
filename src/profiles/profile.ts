export interface Profile {
  name: string;
  description?: string;
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  loginShell: boolean;
  /** Absolute path of the file the profile was loaded from. */
  file: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string')
  );
}

/** Validates a parsed profile file. Throws with a readable message on any problem. */
export function parseProfile(
  raw: unknown,
  file: string,
  defaultName: string,
): Profile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('profile must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const name = o.name ?? defaultName;
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('"name" must be a non-empty string');
  if (typeof o.command !== 'string' || o.command.length === 0) {
    throw new Error('"command" must be a non-empty string');
  }
  const args = o.args ?? [];
  if (!isStringArray(args))
    throw new Error('"args" must be an array of strings');
  const cwd = o.cwd ?? null;
  if (cwd !== null && typeof cwd !== 'string')
    throw new Error('"cwd" must be a string or null');
  const env = o.env ?? {};
  if (!isStringRecord(env))
    throw new Error('"env" must be an object of string values');
  const loginShell = o.loginShell ?? false;
  if (typeof loginShell !== 'boolean')
    throw new Error('"loginShell" must be a boolean');
  const description = o.description;
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('"description" must be a string');
  }
  return {
    name,
    description,
    command: o.command,
    args,
    cwd,
    env,
    loginShell,
    file,
  };
}

/** The shape sent to clients: everything except the file path. */
export type PublicProfile = Omit<Profile, 'file'>;

export function toPublicProfile(p: Profile): PublicProfile {
  const { file: _file, ...rest } = p;
  return rest;
}
