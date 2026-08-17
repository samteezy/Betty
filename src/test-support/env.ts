/**
 * Scoped environment variables for tests.
 *
 * `parseDisabledTools()` reads process.env at registration time — CLAUDE.md's
 * one accepted exception to the transport-neutral rule — so tests that exercise
 * DISABLED_TOOLS have to mutate the real environment. This restores it even when
 * the body throws, so one failing assertion can't leak into later tests.
 */

/** Set env vars for the duration of `fn`, then restore. `undefined` unsets. */
export function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T
): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);

  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    const result = fn();
    // Restore after the promise settles, not when it's created, or an async
    // body would see the environment vanish mid-flight.
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}
