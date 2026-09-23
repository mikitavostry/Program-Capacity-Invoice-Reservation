/**
 * Scopes, space-separated in the token's `scope` claim. One per operation, since different
 * systems read availability, reserve and record repayments.
 */
export const Scopes = {
  CapacityRead: 'capacity:read',
  ReservationsWrite: 'reservations:write',
  RepaymentsWrite: 'repayments:write',
} as const;

export type Scope = (typeof Scopes)[keyof typeof Scopes];

export interface Principal {
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  /** `'*'` for every program. */
  readonly programs: '*' | ReadonlySet<string>;
}

export function canAccessProgram(principal: Principal, programId: string): boolean {
  return principal.programs === '*' || principal.programs.has(programId);
}
