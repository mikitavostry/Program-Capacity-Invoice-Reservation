import type { ReservationCursor } from '../ports/capacity-read-model.js';

export function encodeReservationCursor(cursor: ReservationCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.reservedAt.toISOString(), cursor.reservationId]),
    'utf8',
  ).toString('base64url');
}

export function decodeReservationCursor(encoded: string): ReservationCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) return null;

  const [reservedAt, reservationId] = parsed as unknown[];
  if (typeof reservedAt !== 'string' || typeof reservationId !== 'string') return null;
  if (reservationId.length === 0) return null;

  const at = new Date(reservedAt);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== reservedAt) return null;

  return { reservedAt: at, reservationId };
}
