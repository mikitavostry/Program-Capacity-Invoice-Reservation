import type { ProgramId } from '../ids.js';
import type { Program } from '../program.js';

export interface ProgramRepository {
  /** Loads a program with `FOR UPDATE`; every change to a program starts here. */
  lockById(id: ProgramId): Promise<Program | null>;

  /** Rejects with `ProgramAlreadyExistsError` if the id is taken. */
  insert(program: Program): Promise<void>;

  /** Saves a program loaded with `lockById`; a version mismatch is a bug, not a conflict. */
  save(program: Program): Promise<void>;
}
