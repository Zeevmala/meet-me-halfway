/**
 * Explicit success/failure without exceptions.
 *
 * The codebase previously signalled failure three different ways — throwing
 * (`geographicCentroid`), returning an empty value (`searchNearbyVenues`), and
 * writing a code into React state (`useLiveSession`). Nodes in the execution
 * graph use this type instead, so a caller cannot forget that a step can fail.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Value if successful, otherwise `fallback`. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Map the success value, leaving a failure untouched. */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
