import type { ProgramId } from '../ids.js';
import type { Program } from '../program.js';

export interface ProgramRepository {
  lockById(id: ProgramId): Promise<Program | null>;

  insert(program: Program): Promise<void>;

  save(program: Program): Promise<void>;
}
