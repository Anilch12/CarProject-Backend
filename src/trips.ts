import { createHash } from 'node:crypto';
import { Types, type PipelineStage } from 'mongoose';
import { Customer, Trip, Vehicle } from '../models/index.js';
import { ApiError, conflict, missing } from './errors.js';
import { type PaymentInput, type TripInput, tripPatch } from './validation.js';
import type { z } from 'zod';

export const oid = (id: string) => new Types.ObjectId(id);
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_PAYMENTS = 500;
const MAX_AUDIT = 2000;
export const MAX_RESERVATIONS = 5000;
export function financials(trip: { totalAmountPaise: number; payments: { amountPaise: number; status?: string | null }[] }) {
  const collectedAmountPaise = trip.payments.filter(p => p.status === 'valid').reduce((sum, p) => sum + p.amountPaise, 0);
  const balanceAmountPaise = trip.totalAmountPaise - collectedAmountPaise;
  return { collectedAmountPaise, balanceAmountPaise,
    paymentStatus: balanceAmountPaise === 0 ? 'paid' : collectedAmountPaise === 0 ? 'unpaid' : 'partial' };
}
export const financialStages: PipelineStage[] = [
  { $set: { collectedAmountPaise: { $sum: { $map: { input: { $filter: { input: '$payments', as: 'p', cond: { $eq: ['$$p.status', 'valid'] } } }, as: 'p', in: '$$p.amountPaise' } } } } },
  { $set: { balanceAmountPaise: { $subtract: ['$totalAmountPaise', '$collectedAmountPaise'] } } },
  { $set: { paymentStatus: { $cond: [{ $eq: ['$balanceAmountPaise', 0] }, 'paid', { $cond: [{ $eq: ['$collectedAmountPaise', 0] }, 'unpaid', 'partial'] }] } } },
];
export async function getTrip(ownerId: string, id: string) {
  const trip = await Trip.findOne({ _id: oid(id), ownerId: oid(ownerId) }).lean();
  if (!trip) missing();
  return trip;
}
export function tripResponse(trip: Omit<Awaited<ReturnType<typeof getTrip>>, '__v'>) {
  const { reservationToken: _token, ...rest } = trip;
  return { ...rest, ...financials(trip) };
}
function audit(ownerId: string, action: string, details: unknown) {
  return { actorId: oid(ownerId), action, at: new Date(), details };
}
function auditCapacity(trip: { audit: unknown[] }) {
  if (trip.audit.length >= MAX_AUDIT) conflict('HISTORY_LIMIT', 'Trip audit capacity reached; contact the administrator. History has been preserved.');
}
async function validateLinks(ownerId: string, input: { customerId: string; vehicleId: string }) {
  const [customer, vehicle] = await Promise.all([
    Customer.exists({ _id: oid(input.customerId), ownerId: oid(ownerId) }),
    Vehicle.exists({ _id: oid(input.vehicleId), ownerId: oid(ownerId) }),
  ]);
  if (!customer || !vehicle) throw new ApiError(422, 'INVALID_LINK', 'Customer and vehicle must belong to the authenticated owner');
}

// The overlap predicate and reservation insertion execute atomically on ONE vehicle.
// A reservation is never expired automatically. Uncertain write results fail closed.
async function reserve(ownerId: string, vehicleId: string, tripId: Types.ObjectId, startAt: Date, endAt: Date) {
  const token = new Types.ObjectId();
  const result = await Vehicle.updateOne({
    _id: oid(vehicleId), ownerId: oid(ownerId), isActive: true,
    reservations: { $not: { $elemMatch: { tripId: { $ne: tripId }, startAt: { $lt: endAt }, endAt: { $gt: startAt } } } },
    $expr: { $lt: [{ $size: '$reservations' }, MAX_RESERVATIONS] },
  }, { $push: { reservations: { token, tripId, startAt, endAt, createdAt: new Date() } } });
  if (result.modifiedCount !== 1) conflict('BOOKING_CONFLICT', 'Vehicle is inactive, reserved during this interval, or at reservation capacity. Review bookings and retained reservations.');
  return token;
}
async function release(ownerId: string, vehicleId: Types.ObjectId, token: Types.ObjectId | null | undefined) {
  if (!token) return;
  await Vehicle.updateOne({ _id: vehicleId, ownerId: oid(ownerId) }, { $pull: { reservations: { token } } });
}
export function makePayment(ownerId: string, input: PaymentInput, key: string) {
  return { _id: new Types.ObjectId(), ...input, status: 'valid' as const, idempotencyKey: key,
    requestFingerprint: fingerprint(input), createdBy: oid(ownerId), createdAt: new Date(),
    voidedAt: null, voidedBy: null, voidReason: null };
}
type Source = { importId: Types.ObjectId; sheet: string; rowNumber: number; resolutionFingerprint: string; reviewNote: string };
export async function createTrip(ownerId: string, input: TripInput, imported?: { id: Types.ObjectId; source: Source; payments: PaymentInput[] }) {
  await validateLinks(ownerId, input);
  const tripId = imported?.id ?? new Types.ObjectId();
  const payments = (imported?.payments ?? []).map((p, i) => makePayment(ownerId, p, `import:${i}`));
  const collected = payments.reduce((sum, p) => sum + p.amountPaise, 0);
  if (!Number.isSafeInteger(collected) || collected > input.totalAmountPaise) throw new ApiError(422, 'OVERPAYMENT', 'Reviewed payments exceed the trip charge');
  const reservationToken = input.status === 'cancelled' ? null : await reserve(ownerId, input.vehicleId, tripId, input.startAt, input.endAt);
  // On ANY uncertain insert failure, retain the reservation. Removing it could expose
  // a successfully persisted trip to double booking. The inspection command reports it.
  const trip = await Trip.create({ _id: tripId, ...input, ownerId: oid(ownerId), reservationToken, payments,
    source: imported?.source,
    audit: [audit(ownerId, imported ? 'import.committed' : 'trip.created', { input, source: imported?.source, paymentIds: payments.map(p => p._id) })],
  });
  return tripResponse(trip.toObject());
}

export async function patchTrip(ownerId: string, id: string, patch: z.infer<typeof tripPatch>) {
  const old = await getTrip(ownerId, id);
  auditCapacity(old);
  const { changeReason, ...changes } = patch;
  const next = { ...old, ...changes };
  if (next.endAt <= next.startAt) throw new ApiError(422, 'INVALID_DATES', 'endAt must be after startAt');
  if (next.totalAmountPaise < financials(old).collectedAmountPaise) conflict('CHARGE_BELOW_COLLECTIONS', 'Charge cannot be lower than valid collections');
  await validateLinks(ownerId, { customerId: String(next.customerId), vehicleId: String(next.vehicleId) });
  const bookingChanged = String(next.vehicleId) !== String(old.vehicleId) || +next.startAt !== +old.startAt || +next.endAt !== +old.endAt ||
    (next.status === 'cancelled') !== (old.status === 'cancelled');
  let token = old.reservationToken;
  if (bookingChanged) token = next.status === 'cancelled' ? null : await reserve(ownerId, String(next.vehicleId), old._id, next.startAt, next.endAt);
  const updated = await Trip.findOneAndUpdate({ _id: old._id, ownerId: oid(ownerId), revision: old.revision }, {
    $set: { ...changes, reservationToken: token }, $inc: { revision: 1 },
    $push: { audit: audit(ownerId, next.status === 'cancelled' && old.status !== 'cancelled' ? 'trip.cancelled' : 'trip.updated', {
      reason: changeReason, before: Object.fromEntries(Object.keys(changes).map(k => [k, old[k as keyof typeof old]])), after: changes,
    }) },
  }, { returnDocument: 'after', runValidators: true }).lean();
  if (!updated) {
    // A definite CAS miss means this operation did not write the trip.
    if (bookingChanged && token) await release(ownerId, oid(String(next.vehicleId)), token);
    conflict('CONCURRENT_CHANGE', 'Trip changed concurrently. Fetch the latest trip and retry your change.');
  }
  if (bookingChanged) await release(ownerId, old.vehicleId, old.reservationToken);
  return tripResponse(updated);
}

export async function addPayment(ownerId: string, id: string, input: PaymentInput, key: string) {
  const digest = fingerprint(input);
  const payment = makePayment(ownerId, input, key);
  for (let attempt = 0; attempt < 20; attempt++) {
    const trip = await getTrip(ownerId, id);
    const existing = trip.payments.find(p => p.idempotencyKey === key);
    if (existing) {
      if (existing.requestFingerprint !== digest) conflict('IDEMPOTENCY_CONFLICT', 'This key was already used with a different payment payload');
      return { payment: existing, replayed: true };
    }
    auditCapacity(trip);
    if (trip.payments.length >= MAX_PAYMENTS) conflict('HISTORY_LIMIT', 'Maximum 500 payment entries per trip reached. History has been preserved.');
    if (input.amountPaise > financials(trip).balanceAmountPaise) conflict('OVERPAYMENT', 'Payment exceeds the remaining balance');
    const result = await Trip.updateOne({ _id: trip._id, ownerId: oid(ownerId), revision: trip.revision,
      'payments.idempotencyKey': { $ne: key } }, {
      $push: { payments: payment, audit: audit(ownerId, 'payment.created', { paymentId: payment._id, amountPaise: input.amountPaise, idempotencyKey: key }) },
      $inc: { revision: 1 },
    }, { runValidators: true });
    if (result.modifiedCount === 1) return { payment, replayed: false };
  }
  conflict('CONCURRENT_CHANGE', 'High contention. Retry using the same idempotency key.');
}

export async function voidPayment(ownerId: string, id: string, paymentId: string, reason: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const trip = await getTrip(ownerId, id);
    const payment = trip.payments.find(p => String(p._id) === paymentId);
    if (!payment) missing();
    if (payment.status === 'voided') {
      if (payment.voidReason !== reason) conflict('ALREADY_VOIDED', 'Payment is already voided with a different reason');
      return payment;
    }
    auditCapacity(trip);
    const at = new Date();
    const updated = await Trip.findOneAndUpdate({ _id: trip._id, ownerId: oid(ownerId), revision: trip.revision,
      payments: { $elemMatch: { _id: oid(paymentId), status: 'valid' } } }, {
      $set: { 'payments.$.status': 'voided', 'payments.$.voidedBy': oid(ownerId), 'payments.$.voidedAt': at, 'payments.$.voidReason': reason },
      $inc: { revision: 1 }, $push: { audit: audit(ownerId, 'payment.voided', { paymentId, reason, amountPaise: payment.amountPaise }) },
    }, { returnDocument: 'after', runValidators: true }).lean();
    if (updated) return updated.payments.find(p => String(p._id) === paymentId)!;
  }
  conflict('CONCURRENT_CHANGE', 'High contention. Retry the void request.');
}
