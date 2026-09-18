import type { Prisma } from '../../../../../generated/prisma/client.js';
import { InvariantViolationError } from '../../../../../shared/domain/invariant-violation-error.js';
import { ProgramAlreadyExistsError } from '../../../domain/errors.js';
import type { ProgramId } from '../../../domain/ids.js';
import type { ProgramRepository } from '../../../domain/ports/program-repository.js';
import type { Program } from '../../../domain/program.js';
import { fromProgram, toProgram, type ProgramRow } from './mappers.js';
import { isUniqueViolation } from './postgres-errors.js';

export class PrismaProgramRepository implements ProgramRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async lockById(id: ProgramId): Promise<Program | null> {
    // Locks and reads in one round trip. Prisma's query API has no FOR UPDATE, which is the
    // only reason this is raw SQL; the aliases shape the row like the generated model so
    // both paths share one mapper.
    const rows = await this.tx.$queryRaw<ProgramRow[]>`
      SELECT id,
             currency,
             credit_limit_minor AS "creditLimitMinor",
             reserved_minor     AS "reservedMinor",
             status::text       AS status,
             version
        FROM programs
       WHERE id = ${id.value}
         FOR UPDATE`;

    return rows.length === 0 ? null : toProgram(rows[0]);
  }

  async insert(program: Program): Promise<void> {
    try {
      await this.tx.program.create({ data: fromProgram(program) });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProgramAlreadyExistsError(program.id);
      throw error;
    }
  }

  async save(program: Program): Promise<void> {
    const { count } = await this.tx.program.updateMany({
      where: { id: program.id.value, version: program.version },
      data: {
        creditLimitMinor: program.creditLimit.minorUnits,
        reservedMinor: program.reservedAmount.minorUnits,
        status: program.status,
        version: { increment: 1 },
      },
    });

    if (count !== 1) {
      throw new InvariantViolationError(
        `Program ${program.id.value} changed while locked (expected version ${program.version}); it must be loaded with lockById in the same transaction before it is saved.`,
      );
    }
  }
}
