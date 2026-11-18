import { z } from 'zod';

export const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Expected a MongoDB ObjectId').transform(v => v.toLowerCase());
export const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const timestamp = z.iso.datetime({ offset: true }).transform(v => new Date(v));
export const billingUnit = z.enum(['12_hours', '24_hours', 'day', 'fixed']);
export const tripStatus = z.enum(['booked', 'ongoing', 'completed', 'cancelled']);
export const paymentStatus = z.enum(['unpaid', 'partial', 'paid']);
const name = z.string().trim().min(1).max(150);
const notes = z.string().max(2000);
export const customerCreate = z.object({ name, phone: z.string().trim().min(5).max(30).optional(), notes: notes.default('') }).strict();
export const customerPatch = customerCreate.partial().refine(v => Object.keys(v).length > 0, 'Supply at least one field');
export const registration = z.string().trim().transform(v => v.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^[A-Z0-9]{4,20}$/, 'Registration must contain 4–20 letters and digits'));
export const vehicleCreate = z.object({ registrationNumber: registration, displayName: name, isActive: z.boolean().default(true) }).strict();
export const vehiclePatch = vehicleCreate.partial().refine(v => Object.keys(v).length > 0, 'Supply at least one field');
export const tripFields = z.object({
  customerId: objectId, vehicleId: objectId, routeName: name, startAt: timestamp, endAt: timestamp,
  billingUnit, totalAmountPaise: amount, currency: z.literal('INR').default('INR'),
  status: tripStatus.default('booked'), notes: notes.default(''),
}).strict();
export const tripCreate = tripFields.refine(v => v.endAt > v.startAt, { message: 'endAt must be after startAt', path: ['endAt'] });
export const tripPatch = tripFields.partial().extend({ changeReason: z.string().trim().min(3).max(500) }).strict()
  .refine(v => Object.keys(v).some(k => k !== 'changeReason'), 'Supply at least one field to change');
export const paymentFields = z.object({
  amountPaise: amount.refine(v => v > 0, 'Payment must be positive'),
  purpose: z.enum(['advance', 'installment', 'final']), method: z.enum(['cash', 'upi', 'bank_transfer', 'card', 'unknown']),
  paidAt: timestamp.nullable(), reference: z.string().trim().min(1).max(150).nullable().default(null),
}).strict();
// Only reviewed imports can create undated historical payments.
export const paymentCreate = paymentFields.extend({ paidAt: timestamp }).strict();
export const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const voidInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const day = z.iso.date().refine(v => v >= '2000-01-01' && v <= '2100-12-31', 'Reporting date must be in 2000–2100');
export const period = z.object({ from: day.optional(), to: day.optional() }).refine(v => !v.from || !v.to || v.from <= v.to,
  'from must be on or before to');
export const tripQuery = pagination.extend({ from: day.optional(), to: day.optional(), customerId: objectId.optional(),
  vehicleId: objectId.optional(), status: tripStatus.optional(), paymentStatus: paymentStatus.optional() }).strict()
  .refine(v => !v.from || !v.to || v.from <= v.to, 'from must be on or before to');
export const loginInput = z.object({ email: z.email().trim().toLowerCase(), password: z.string().min(1).max(256) }).strict();
export const commitRow = z.object({ sheet: z.string().min(1).max(100), rowNumber: z.number().int().min(1),
  reviewed: z.literal(true), reviewNote: z.string().trim().min(10).max(2000), trip: tripCreate,
  payments: z.array(paymentFields).max(100),
}).strict();
export const commitInput = z.object({ rows: z.array(commitRow).min(1).max(50) }).strict();
export type TripInput = z.infer<typeof tripCreate>;
export type PaymentInput = z.infer<typeof paymentFields>;

// Inclusive local calendar dates -> UTC [from midnight, day after to midnight).
export function dateRange(from?: string, to?: string) {
  const range: { $gte?: Date; $lt?: Date } = {};
  if (from) range.$gte = new Date(`${from}T00:00:00+05:30`);
  if (to) range.$lt = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400000);
  return range;
}
