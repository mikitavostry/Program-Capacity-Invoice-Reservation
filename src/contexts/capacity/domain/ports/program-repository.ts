import type { ProgramId } from '../ids.js';
import type { Program } from '../program.js';

export interface ProgramRepository {
  /**
   * Loads a program and holds its row lock until the surrounding transaction ends, so no
   * other writer can change its capacity in the meantime. Every change to a program's
   * capacity starts here; see docs/architecture.md §6.
   */
  lockById(id: ProgramId): Promise<Program | null>;

  insert(program: Program): Promise<void>;

  /**
   * Persists a program loaded with `lockById` in the same transaction. The stored version
   * is compared as it is written: under the lock it cannot have moved, so a mismatch is
   * reported as an invariant violation rather than retried.
   */
  save(program: Program): Promise<void>;
}
