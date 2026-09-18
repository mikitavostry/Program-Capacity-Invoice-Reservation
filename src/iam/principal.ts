/** Scopes a bearer token can carry, in OAuth 2 style: space-separated in the `scope` claim. */
export const Scopes = {
  /** Read a program's capacity and its reservations. */
  CapacityRead: 'capacity:read',
  /** Reserve capacity and record repayments. */
  CapacityWrite: 'capacity:write',
  /** Open programs. */
  ProgramsAdmin: 'programs:admin',
} as const;

export type Scope = (typeof Scopes)[keyof typeof Scopes];

/** Who is calling, and what they may touch — derived from a verified token, never the request. */
export interface Principal {
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  /** The programs this caller may act on; `'*'` for all of them. */
  readonly programs: '*' | ReadonlySet<string>;
}

export function canAccessProgram(principal: Principal, programId: string): boolean {
  return principal.programs === '*' || principal.programs.has(programId);
}
