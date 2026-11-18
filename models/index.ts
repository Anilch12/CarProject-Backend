import mongoose, { Schema } from 'mongoose';

const oid = Schema.Types.ObjectId;
const options = { timestamps: true, strict: 'throw', versionKey: false, autoIndex: false, autoCreate: false } as const;
const money = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const owner = { type: oid, required: true, immutable: true };
const OwnerSchema = new Schema({
  email: { type: String, required: true }, passwordHash: { type: String, required: true, select: false },
  name: { type: String, required: true }, active: { type: Boolean, default: true },
}, options);
OwnerSchema.index({ email: 1 }, { unique: true });
export const Owner = mongoose.model('Owner', OwnerSchema);

const CustomerSchema = new Schema({
  ownerId: owner, name: { type: String, required: true }, phone: String, notes: { type: String, default: '' },
}, options);
CustomerSchema.index({ ownerId: 1, name: 1, _id: 1 });
CustomerSchema.index({ ownerId: 1, createdAt: -1, _id: -1 });
export const Customer = mongoose.model('Customer', CustomerSchema);

const ReservationSchema = new Schema({
  token: { type: oid, required: true }, tripId: { type: oid, required: true },
  startAt: { type: Date, required: true }, endAt: { type: Date, required: true },
  createdAt: { type: Date, required: true },
}, { _id: false });
const VehicleSchema = new Schema({
  ownerId: owner, registrationNumber: { type: String, required: true }, displayName: { type: String, required: true },
  isActive: { type: Boolean, default: true }, reservations: { type: [ReservationSchema], default: [], select: false },
}, options);
VehicleSchema.index({ ownerId: 1, registrationNumber: 1 }, { unique: true });
VehicleSchema.index({ ownerId: 1, createdAt: -1, _id: -1 });
export const Vehicle = mongoose.model('Vehicle', VehicleSchema);

const PaymentSchema = new Schema({
  amountPaise: { ...money, min: 1 }, purpose: { type: String, required: true, enum: ['advance', 'installment', 'final'] },
  method: { type: String, required: true, enum: ['cash', 'upi', 'bank_transfer', 'card', 'unknown'] },
  paidAt: { type: Date, default: null }, reference: { type: String, default: null },
  status: { type: String, enum: ['valid', 'voided'], default: 'valid' },
  idempotencyKey: { type: String, required: true }, requestFingerprint: { type: String, required: true },
  createdBy: { type: oid, required: true }, createdAt: { type: Date, required: true },
  voidedAt: { type: Date, default: null }, voidedBy: { type: oid, default: null }, voidReason: { type: String, default: null },
});
const AuditSchema = new Schema({
  action: { type: String, required: true }, actorId: { type: oid, required: true }, at: { type: Date, required: true },
  details: { type: Schema.Types.Mixed, required: true },
}, { _id: false });
const SourceSchema = new Schema({
  importId: { type: oid, required: true }, sheet: { type: String, required: true }, rowNumber: { type: Number, required: true },
  resolutionFingerprint: { type: String, required: true }, reviewNote: { type: String, required: true },
}, { _id: false });
const TripSchema = new Schema({
  ownerId: owner, customerId: { type: oid, required: true }, vehicleId: { type: oid, required: true },
  routeName: { type: String, required: true }, startAt: { type: Date, required: true }, endAt: { type: Date, required: true },
  billingUnit: { type: String, required: true, enum: ['12_hours', '24_hours', 'day', 'fixed'] },
  totalAmountPaise: money, currency: { type: String, enum: ['INR'], default: 'INR' },
  status: { type: String, enum: ['booked', 'ongoing', 'completed', 'cancelled'], default: 'booked' },
  notes: { type: String, default: '' }, payments: { type: [PaymentSchema], default: [] },
  audit: { type: [AuditSchema], default: [] }, revision: { type: Number, default: 0 },
  reservationToken: { type: oid, default: null }, source: { type: SourceSchema, default: undefined },
}, options);
TripSchema.index({ ownerId: 1, startAt: -1, _id: -1 });
TripSchema.index({ ownerId: 1, customerId: 1, startAt: -1, _id: -1 });
TripSchema.index({ ownerId: 1, vehicleId: 1, startAt: 1, endAt: 1 });
TripSchema.index({ ownerId: 1, status: 1, startAt: -1, _id: -1 });
TripSchema.index({ ownerId: 1, 'payments.paidAt': 1 });
TripSchema.index({ ownerId: 1, 'source.importId': 1, 'source.sheet': 1, 'source.rowNumber': 1 },
  { unique: true, partialFilterExpression: { 'source.importId': { $type: 'objectId' } } });
export const Trip = mongoose.model('Trip', TripSchema);

const ImportSchema = new Schema({
  ownerId: owner, fileHash: { type: String, required: true }, fileName: { type: String, required: true },
  originalFile: { type: Buffer, required: true, select: false },
  rows: { type: [Schema.Types.Mixed], required: true }, totals: { type: Schema.Types.Mixed, required: true },
}, options);
ImportSchema.index({ ownerId: 1, fileHash: 1 }, { unique: true });
export const ImportBatch = mongoose.model('ImportBatch', ImportSchema);
export const models = [Owner, Customer, Vehicle, Trip, ImportBatch];

export async function connectDatabase(uri: string) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false, writeConcern: { w: 1, j: true } });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  return { type: hello.setName ? 'replicaSet' : hello.msg === 'isdbgrid' ? 'sharded' : 'standalone' };
}
export async function ensureIndexes() { for (const model of models) await model.createIndexes(); }
