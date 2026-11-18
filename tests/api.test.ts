import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import request from 'supertest';
import writeExcelFile, { type SheetData } from 'write-excel-file/node';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createApp } from '../src/app.js';
import { connectDatabase, ensureIndexes, Owner, Customer, Vehicle, Trip, ImportBatch } from '../models/index.js';
import { signToken } from '../src/auth.js';
import { parseWorkbook } from '../src/imports.js';
import { financials } from '../src/trips.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(48).toString('hex');
const base = new URL(process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details_test');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !/^\/car_details_test(?:_[a-zA-Z0-9]+)*$/.test(base.pathname)) {
  throw new Error('Tests require a local database named car_details_test or car_details_test_*');
}
base.pathname = `/car_details_test_${randomBytes(12).toString('hex')}`;
const testDb = base.pathname.slice(1);
const app = createApp();
let ownsTestDatabase = false;
before(async () => {
  const deployment = await connectDatabase(base.toString());
  if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error('Refusing to use an existing test database');
  ownsTestDatabase = true;
  await ensureIndexes();
  console.log(`Integration database: ${testDb}; deployment: ${deployment.type}`);
});
after(async () => {
  if (ownsTestDatabase && mongoose.connection.name === testDb) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
async function fixture() {
  const owner = await Owner.create({ name: 'Test Owner', email: `${randomBytes(8).toString('hex')}@example.test`, passwordHash: await argon2.hash('Test-password-123!') });
  const token = await signToken(String(owner._id));
  const customer = await Customer.create({ ownerId: owner._id, name: 'Same Name' });
  const vehicle = await Vehicle.create({ ownerId: owner._id, registrationNumber: randomBytes(6).toString('hex').toUpperCase(), displayName: 'Test car' });
  const auth = `Bearer ${token}`;
  const input = { customerId: String(customer._id), vehicleId: String(vehicle._id), routeName: 'Test route',
    startAt: '2026-11-01T09:00:00+05:30', endAt: '2026-11-01T18:00:00+05:30', billingUnit: 'fixed', totalAmountPaise: 200000, status: 'completed' };
  const create = (changes = {}) => request(app).post('/api/v1/trips').set('Authorization', auth).send({ ...input, ...changes });
  const payment = (id: string, key: string, amountPaise: number, changes = {}) => request(app).post(`/api/v1/trips/${id}/payments`)
    .set('Authorization', auth).set('Idempotency-Key', key).send({ amountPaise, purpose: 'advance', method: 'cash', paidAt: '2026-11-01T10:00:00+05:30', ...changes });
  return { owner, customer, vehicle, auth, input, create, payment };
}
const expectStatus = (response: request.Response, status: number) => assert.equal(response.status, status, JSON.stringify(response.body));

test('health, hashed owner login, invalid credentials and authenticated endpoints', async () => {
  const f = await fixture();
  expectStatus(await request(app).get('/health'), 200);
  expectStatus(await request(app).get('/api/v1/trips'), 401);
  expectStatus(await request(app).get('/api/v1/trips').set('Authorization', 'Bearer bogus'), 401);
  const login = await request(app).post('/api/v1/auth/login').send({ email: f.owner.email, password: 'Test-password-123!' });
  expectStatus(login, 200); assert.ok(login.body.data.accessToken);
  expectStatus(await request(app).post('/api/v1/auth/login').send({ email: f.owner.email, password: 'wrong' }), 401);
});

test('advance plus final calculates collections once; completion and payment status are independent', async () => {
  const f = await fixture(); const created = await f.create(); expectStatus(created, 201); const id = created.body.data._id;
  assert.equal(created.body.data.paymentStatus, 'unpaid');
  expectStatus(await f.payment(id, 'advance-0001', 80000), 201);
  let got = await request(app).get(`/api/v1/trips/${id}`).set('Authorization', f.auth);
  assert.equal(got.body.data.balanceAmountPaise, 120000); assert.equal(got.body.data.paymentStatus, 'partial');
  expectStatus(await f.payment(id, 'final-000001', 120000, { purpose: 'final' }), 201);
  got = await request(app).get(`/api/v1/trips/${id}`).set('Authorization', f.auth);
  assert.equal(got.body.data.collectedAmountPaise, 200000); assert.equal(got.body.data.balanceAmountPaise, 0); assert.equal(got.body.data.paymentStatus, 'paid');
  expectStatus(await f.payment(id, 'overpaid-001', 1), 409);
});

test('concurrent identical retries persist one payment; conflicting key payload returns 409', async () => {
  const f = await fixture(); const id = (await f.create()).body.data._id;
  const attempts = await Promise.all(Array.from({ length: 12 }, () => f.payment(id, 'retry-key-001', 80000)));
  assert.equal(attempts.filter(r => r.status === 201).length, 1);
  assert.equal(attempts.filter(r => r.status === 200).length, 11);
  assert.equal(new Set(attempts.map(r => r.body.data._id)).size, 1);
  const conflict = await f.payment(id, 'retry-key-001', 80001); expectStatus(conflict, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const trip = await Trip.findById(id).lean(); assert.equal(trip!.payments.length, 1);
});

test('concurrent different payments cannot exceed the remaining balance', async () => {
  const f = await fixture(); const id = (await f.create({ totalAmountPaise: 100000 })).body.data._id;
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => f.payment(id, `competing-${i}`, 60000)));
  assert.equal(attempts.filter(r => r.status === 201).length, 1);
  assert.ok(attempts.every(r => [201, 409].includes(r.status)));
  assert.equal(financials((await Trip.findById(id).lean())!).collectedAmountPaise, 60000);
});

test('concurrent charge reduction and payment preserve the financial invariant', async () => {
  const f = await fixture(); const id = (await f.create({ totalAmountPaise: 100000 })).body.data._id;
  const results = await Promise.all([
    f.payment(id, 'charge-race-01', 80000),
    request(app).patch(`/api/v1/trips/${id}`).set('Authorization', f.auth).send({ totalAmountPaise: 50000, changeReason: 'Correct mistaken charge' }),
  ]);
  assert.ok(results.every(r => [200, 201, 409].includes(r.status)));
  assert.equal(results.filter(r => r.status < 300).length, 1);
  const trip = (await Trip.findById(id).lean())!;
  assert.ok(financials(trip).balanceAmountPaise >= 0);
});

test('voiding preserves history, supports retries, and cancellation retains balances', async () => {
  const f = await fixture(); const id = (await f.create()).body.data._id;
  const payment = await f.payment(id, 'void-key-001', 80000); const pid = payment.body.data._id;
  const doVoid = () => request(app).post(`/api/v1/trips/${id}/payments/${pid}/void`).set('Authorization', f.auth).send({ reason: 'Duplicate paper entry' });
  const responses = await Promise.all([doVoid(), doVoid()]); responses.forEach(r => expectStatus(r, 200));
  const retry = await f.payment(id, 'void-key-001', 80000); expectStatus(retry, 200); assert.equal(retry.body.data.status, 'voided');
  const cancelled = await request(app).patch(`/api/v1/trips/${id}`).set('Authorization', f.auth).send({ status: 'cancelled', changeReason: 'Customer cancelled' });
  expectStatus(cancelled, 200); assert.equal(cancelled.body.data.balanceAmountPaise, 200000);
  const trip = (await Trip.findById(id).lean())!;
  assert.equal(trip.payments.length, 1); assert.equal(trip.audit.filter(a => a.action === 'payment.voided').length, 1);
  assert.ok(trip.payments[0].voidedBy); assert.ok(trip.payments[0].voidedAt);
  expectStatus(await f.create(), 201); // Cancelled booking released its vehicle interval.
});

test('concurrent void and new payment never lose ledger entries', async () => {
  const f = await fixture(); const id = (await f.create({ totalAmountPaise: 100000 })).body.data._id;
  const pid = (await f.payment(id, 'initial-race-01', 60000)).body.data._id;
  const responses = await Promise.all([
    request(app).post(`/api/v1/trips/${id}/payments/${pid}/void`).set('Authorization', f.auth).send({ reason: 'Wrong receipt' }),
    f.payment(id, 'second-race-01', 40000),
  ]);
  expectStatus(responses[0], 200); expectStatus(responses[1], 201);
  const trip = (await Trip.findById(id).lean())!;
  assert.equal(trip.payments.length, 2); assert.equal(financials(trip).collectedAmountPaise, 40000);
});

test('strict validation rejects impossible dates, timezone-free timestamps, invalid ids and forged totals', async () => {
  const f = await fixture();
  for (const changes of [{ startAt: '2026-02-30T09:00:00+05:30' }, { startAt: '2026-11-01T09:00:00' },
    { startAt: '2026-11-02T09:00:00+05:30' }, { endAt: f.input.startAt }, { customerId: 'bad' },
    { collectedAmountPaise: 1 }, { ownerId: String(f.owner._id) }, { totalAmountPaise: 1.1 }, { totalAmountPaise: Number.MAX_SAFE_INTEGER + 1 }]) {
    expectStatus(await f.create(changes), 422);
  }
  const id = (await f.create()).body.data._id;
  for (const amount of [0, -1, 0.5]) expectStatus(await f.payment(id, 'invalid-payment', amount), 422);
  expectStatus(await f.payment(id, 'missing-time', 100, { paidAt: null }), 422);
});

test('concurrent overlapping bookings allow exactly one; adjacent intervals and other vehicles work', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.create()));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 9);
  expectStatus(await f.create({ startAt: f.input.endAt, endAt: '2026-11-01T20:00:00+05:30' }), 201);
  const vehicle = await Vehicle.create({ ownerId: f.owner._id, registrationNumber: 'SECOND001', displayName: 'Second' });
  expectStatus(await f.create({ vehicleId: String(vehicle._id) }), 201);
});

test('booking edits reserve new interval and only release old interval after commit', async () => {
  const f = await fixture(); const first = (await f.create()).body.data._id;
  const second = (await f.create({ startAt: '2026-11-02T09:00:00+05:30', endAt: '2026-11-02T18:00:00+05:30' })).body.data._id;
  const update = await request(app).patch(`/api/v1/trips/${second}`).set('Authorization', f.auth).send({ startAt: f.input.startAt, endAt: f.input.endAt, changeReason: 'Reschedule requested' });
  expectStatus(update, 409);
  const moved = await request(app).patch(`/api/v1/trips/${first}`).set('Authorization', f.auth).send({ startAt: '2026-11-03T09:00:00+05:30', endAt: '2026-11-03T18:00:00+05:30', changeReason: 'Reschedule requested' });
  expectStatus(moved, 200); expectStatus(await f.create(), 201);
});

test('retained reservation blocks bookings even when trip write did not finish', async () => {
  const f = await fixture();
  await Vehicle.updateOne({ _id: f.vehicle._id }, { $push: { reservations: { token: new mongoose.Types.ObjectId(), tripId: new mongoose.Types.ObjectId(),
    startAt: new Date(f.input.startAt), endAt: new Date(f.input.endAt), createdAt: new Date() } } });
  expectStatus(await f.create(), 409);
});

test('ownership isolates reads, writes, links, payments, imports, and aggregates', async () => {
  const a = await fixture(), b = await fixture(); const id = (await a.create()).body.data._id;
  expectStatus(await request(app).get(`/api/v1/trips/${id}`).set('Authorization', b.auth), 404);
  expectStatus(await request(app).patch(`/api/v1/trips/${id}`).set('Authorization', b.auth).send({ totalAmountPaise: 0, changeReason: 'Unauthorized edit' }), 404);
  expectStatus(await b.payment(id, 'foreign-key-01', 100), 404);
  expectStatus(await b.create({ customerId: String(a.customer._id) }), 422);
  expectStatus(await b.create({ vehicleId: String(a.vehicle._id) }), 422);
  expectStatus(await request(app).get(`/api/v1/customers/${a.customer._id}`).set('Authorization', b.auth), 404);
  expectStatus(await request(app).patch(`/api/v1/vehicles/${a.vehicle._id}`).set('Authorization', b.auth).send({ isActive: false }), 404);
  assert.equal((await request(app).get('/api/v1/trips').set('Authorization', b.auth)).body.pagination.total, 0);
  assert.equal((await request(app).get('/api/v1/dashboard/summary').set('Authorization', b.auth)).body.data.tripCount, 0);
});

test('registration normalization is unique per owner and customer names may repeat', async () => {
  const a = await fixture(), b = await fixture();
  const register = (auth: string, registrationNumber: string) => request(app).post('/api/v1/vehicles').set('Authorization', auth).send({ registrationNumber, displayName: 'Car' });
  const first = await register(a.auth, ' ap-07 ab 1234 '); expectStatus(first, 201); assert.equal(first.body.data.registrationNumber, 'AP07AB1234');
  expectStatus(await register(a.auth, 'AP07AB1234'), 409); expectStatus(await register(b.auth, 'AP07AB1234'), 201);
  expectStatus(await request(app).post('/api/v1/customers').set('Authorization', a.auth).send({ name: 'Same Name' }), 201);
});

async function workbook() {
  const rows: (string | number | Date | null)[][] = [[], [], [], [], ['SUMMARY', 999999], [],
    ['Route Name', 'Customer Name', 'Start Date & Time', 'End Date & Time', 'Trip Total Amount', 'Advance Amount', 'Received Amount', 'Balance Amount', '12hrs/24hrs/Days'],
    ['Synthetic route', 'Venky', new Date('2026-11-01T09:00:00Z'), new Date('2026-11-01T18:00:00Z'), 2000, 800, 1200, 0],
    ['Bad route', 'Another customer', '13/09/2026. 5:000M', new Date('2026-09-13T22:00:00Z'), 1000, 0, 1000, 0],
    ['Reverse route', 'Venky', new Date('2026-10-07T05:00:00Z'), new Date('2026-07-10T17:00:00Z'), 2000, 0, 0, 2000],
  ];
  const data = rows.map(row => row.map(value => value instanceof Date ? { value, format: 'dd/mm/yyyy hh:mm' } : { value })) as SheetData;
  return writeExcelFile(data, { sheet: 'Trips' }).toBuffer();
}

test('preview ignores summaries, preserves raw rows and flags all ambiguous fields', async () => {
  const parsed = await parseWorkbook(await workbook());
  assert.equal(parsed.rows.length, 3); assert.equal(parsed.totals.totalAmountPaise, 500000);
  assert.equal(parsed.rows[0].rowNumber, 8); assert.equal(parsed.rows[0].raw['Advance Amount'], 800);
  assert.equal(parsed.rows[0].proposed.payments, null);
  for (const issue of ['AMBIGUOUS_ADVANCE_RECEIVED', 'MISSING_VEHICLE', 'MISSING_BILLING_UNIT', 'MISSING_PAYMENT_DATES', 'MISSING_PAYMENT_METHODS', 'POSSIBLE_DUPLICATE_CUSTOMER']) assert.ok(parsed.rows[0].issues.includes(issue), issue);
  assert.ok(parsed.rows[1].issues.includes('INVALID_OR_AMBIGUOUS_DATE')); assert.ok(parsed.rows[2].issues.includes('END_BEFORE_START'));
});

test('reviewed import retries are persistent and duplicate safe; unresolved rows stay pending', async () => {
  const f = await fixture(); const bytes = await workbook();
  const preview = () => request(app).post('/api/v1/imports/preview').set('Authorization', f.auth).attach('file', bytes, 'synthetic.xlsx');
  const first = await preview(); expectStatus(first, 200); const importId = first.body.data._id;
  assert.equal((await preview()).body.data._id, importId);
  assert.equal(await Trip.countDocuments({ ownerId: f.owner._id }), 0);
  const resolution = { sheet: 'Trips', rowNumber: 8, reviewed: true, reviewNote: 'Reviewed separate advance and receipt; dates and methods remain unknown.', trip: f.input,
    payments: [{ amountPaise: 80000, purpose: 'advance', method: 'unknown', paidAt: null }, { amountPaise: 120000, purpose: 'final', method: 'unknown', paidAt: null }] };
  const commit = (row = resolution) => request(app).post(`/api/v1/imports/${importId}/commit`).set('Authorization', f.auth).send({ rows: [row] });
  const responses = await Promise.all([commit(), commit()]); responses.forEach(r => expectStatus(r, 200));
  assert.ok(responses.every(r => r.body.data[0].status === 'committed'));
  assert.equal(await Trip.countDocuments({ ownerId: f.owner._id }), 1);
  assert.equal((await Trip.findOne({ ownerId: f.owner._id }).lean())!.payments.length, 2);
  assert.equal(responses[0].body.import.rows.filter((r: { state: string }) => r.state === 'pending').length, 2);
  const conflict = await commit({ ...resolution, reviewNote: 'Changed review after committing' });
  assert.equal(conflict.body.data[0].error.code, 'IMPORT_RESOLUTION_CONFLICT');
  const summary = (await request(app).get('/api/v1/dashboard/summary?from=2026-11-01&to=2026-11-01').set('Authorization', f.auth)).body.data;
  assert.equal(summary.currentCollectionsPaise, 200000); assert.equal(summary.paymentsReceivedInPeriodPaise, 0); assert.equal(summary.undatedCollectionsAllTripsPaise, 200000);
  const other = await fixture(); expectStatus(await request(app).get(`/api/v1/imports/${importId}`).set('Authorization', other.auth), 404);
  assert.ok((await ImportBatch.findById(importId).select('+originalFile').lean())!.originalFile);
});

test('dashboard receipt boundaries use Kolkata dates independently of trip start and include cancelled balances', async () => {
  const f = await fixture(); const id = (await f.create({ startAt: '2026-10-01T09:00:00+05:30', endAt: '2026-10-01T18:00:00+05:30' })).body.data._id;
  expectStatus(await f.payment(id, 'before-boundary', 10000, { paidAt: '2026-10-31T18:29:59Z' }), 201);
  expectStatus(await f.payment(id, 'at-boundary-01', 20000, { paidAt: '2026-10-31T18:30:00Z' }), 201);
  expectStatus(await f.payment(id, 'end-boundary-01', 30000, { paidAt: '2026-11-01T18:30:00Z' }), 201);
  const report = (await request(app).get('/api/v1/dashboard/summary?from=2026-11-01&to=2026-11-01').set('Authorization', f.auth)).body.data;
  assert.equal(report.tripCount, 0); assert.equal(report.paymentsReceivedInPeriodPaise, 20000);
  await request(app).patch(`/api/v1/trips/${id}`).set('Authorization', f.auth).send({ status: 'cancelled', changeReason: 'Cancelled with outstanding charge' });
  const october = (await request(app).get('/api/v1/dashboard/summary?from=2026-10-01&to=2026-10-01').set('Authorization', f.auth)).body.data;
  assert.equal(october.tripValuePaise, 200000); assert.equal(october.currentCollectionsPaise, 60000); assert.equal(october.currentOutstandingPaise, 140000); assert.equal(october.cancelledTripCount, 1);
});

test('trip filters derive payment statuses and pagination is bounded and deterministic', async () => {
  const f = await fixture(); const id = (await f.create()).body.data._id; await f.payment(id, 'filter-key-001', 10000);
  const res = await request(app).get(`/api/v1/trips?paymentStatus=partial&customerId=${f.customer._id}&vehicleId=${f.vehicle._id}&status=completed&from=2026-11-01&to=2026-11-01&pageSize=1`).set('Authorization', f.auth);
  expectStatus(res, 200); assert.equal(res.body.pagination.total, 1); assert.equal(res.body.data[0]._id, id);
  assert.equal(res.body.data[0].balanceAmountPaise, 190000);
  expectStatus(await request(app).get('/api/v1/trips?pageSize=101').set('Authorization', f.auth), 422);
  expectStatus(await request(app).get('/api/v1/trips?from=2026-11-02&to=2026-11-01').set('Authorization', f.auth), 422);
  expectStatus(await request(app).get('/api/v1/trips?ownerId=forged').set('Authorization', f.auth), 422);
});

test('OpenAPI document validates and is served to authenticated owners', async () => {
  const doc = await SwaggerParser.validate('openapi.json');
  assert.equal(doc.info.title, 'Car Details API');
  const f = await fixture();
  expectStatus(await request(app).get('/api/v1/openapi.json').set('Authorization', f.auth), 200);
});

test('invalid archive and oversized workbook uploads return actionable errors', async () => {
  const f = await fixture();
  const invalid = await request(app).post('/api/v1/imports/preview').set('Authorization', f.auth).attach('file', Buffer.from('not a zip'), 'bad.xlsx');
  expectStatus(invalid, 422);
  const oversized = await request(app).post('/api/v1/imports/preview').set('Authorization', f.auth).attach('file', Buffer.alloc(2 * 1024 * 1024 + 1), 'big.xlsx');
  expectStatus(oversized, 422);
});

test('owner bootstrap CLI hashes the supplied password and refuses to overwrite credentials', async () => {
  const email = `bootstrap-${randomBytes(6).toString('hex')}@example.test`;
  const env = { ...process.env, MONGODB_URI: base.toString(), BOOTSTRAP_EMAIL: email, BOOTSTRAP_NAME: 'CLI Test Owner', BOOTSTRAP_PASSWORD: 'CLI-test-password-123!' };
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/create-owner.ts'], { env });
  await run();
  const owner = (await Owner.findOne({ email }).select('+passwordHash').lean())!;
  assert.ok(owner.passwordHash.startsWith('$argon2id$'));
  assert.notEqual(owner.passwordHash, env.BOOTSTRAP_PASSWORD);
  await assert.rejects(run());
  assert.equal((await Owner.findOne({ email }).select('+passwordHash').lean())!.passwordHash, owner.passwordHash);
  expectStatus(await request(app).post('/api/v1/auth/login').send({ email, password: env.BOOTSTRAP_PASSWORD }), 200);
});

test('idempotency keys are scoped to a trip and foreign payment voids are denied', async () => {
  const f = await fixture(); const other = await fixture();
  const one = (await f.create()).body.data._id;
  const two = (await f.create({ startAt: '2026-11-02T09:00:00+05:30', endAt: '2026-11-02T18:00:00+05:30' })).body.data._id;
  const payment = await f.payment(one, 'same-key-two-trips', 80000);
  expectStatus(await f.payment(two, 'same-key-two-trips', 80000), 201);
  expectStatus(await request(app).post(`/api/v1/trips/${one}/payments/${payment.body.data._id}/void`).set('Authorization', other.auth).send({ reason: 'Foreign void attempt' }), 404);
  expectStatus(await request(app).patch(`/api/v1/trips/${one}`).set('Authorization', f.auth).send({ totalAmountPaise: 79999, changeReason: 'Invalid charge reduction' }), 409);
  await Owner.updateOne({ _id: f.owner._id }, { $set: { active: false } });
  expectStatus(await request(app).get(`/api/v1/trips/${one}`).set('Authorization', f.auth), 401);
});

test('concurrent rescheduling of different trips cannot reserve the same new interval', async () => {
  const f = await fixture(); const one = (await f.create()).body.data._id;
  const two = (await f.create({ startAt: '2026-11-02T09:00:00+05:30', endAt: '2026-11-02T18:00:00+05:30' })).body.data._id;
  const move = (id: string) => request(app).patch(`/api/v1/trips/${id}`).set('Authorization', f.auth)
    .send({ startAt: '2026-11-03T09:00:00+05:30', endAt: '2026-11-03T18:00:00+05:30', changeReason: 'Concurrent rescheduling' });
  const responses = await Promise.all([move(one), move(two)]);
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 1);
});
