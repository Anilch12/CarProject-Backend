import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as v from '../src/validation.js';

type Json = Record<string, any>;
function input(schema: z.ZodType): Json {
  const { $schema, ...result } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return result;
}
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const id = { type: 'string', pattern: '^[a-fA-F0-9]{24}$', example: '507f1f77bcf86cd799439011' };
const date = { type: 'string', format: 'date-time', example: '2026-11-01T09:00:00+05:30' };
const money = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, example: 200000 };
const timestamps = { _id: id, ownerId: id, createdAt: date, updatedAt: date };
const object = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required });
const array = (items: Json) => ({ type: 'array', items });
const envelope = (data: Json) => object({ data }, ['data']);
const pagination = object({ page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' } }, ['page', 'pageSize', 'total']);
const list = (item: Json) => object({ data: array(item), pagination }, ['data', 'pagination']);
const schemas: Json = {
  Error: object({ error: object({ code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: array(object({ path: { type: 'string' }, message: { type: 'string' } })) }, ['code', 'message']) }, ['error']),
  CustomerInput: input(v.customerCreate), CustomerPatch: input(v.customerPatch),
  VehicleInput: input(v.vehicleCreate), VehiclePatch: input(v.vehiclePatch),
  TripInput: { ...input(v.tripCreate), description: 'endAt must be after startAt. Currency is INR; timestamps require offsets. Unknown fields including calculated totals are rejected.' },
  TripPatch: { ...input(v.tripPatch), description: 'changeReason is required. Charge cannot fall below valid collections. Booking changes use atomic reservations. A concurrent modification returns 409.' },
  PaymentInput: input(v.paymentCreate), HistoricalPaymentInput: input(v.paymentFields),
  VoidInput: input(v.voidInput), LoginInput: input(v.loginInput), ImportCommitInput: input(v.commitInput),
  Customer: object({ ...timestamps, name: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' } }, ['_id', 'ownerId', 'name']),
  Vehicle: object({ ...timestamps, registrationNumber: { type: 'string' }, displayName: { type: 'string' }, isActive: { type: 'boolean' } }, ['_id', 'ownerId', 'registrationNumber', 'displayName', 'isActive']),
  Payment: object({ _id: id, amountPaise: money, purpose: { enum: ['advance', 'installment', 'final'] },
    method: { enum: ['cash', 'upi', 'bank_transfer', 'card', 'unknown'] }, paidAt: { anyOf: [date, { type: 'null' }] },
    reference: { type: ['string', 'null'] }, status: { enum: ['valid', 'voided'] }, idempotencyKey: { type: 'string' }, requestFingerprint: { type: 'string' },
    createdBy: id, createdAt: date, voidedAt: { anyOf: [date, { type: 'null' }] }, voidedBy: { anyOf: [id, { type: 'null' }] }, voidReason: { type: ['string', 'null'] },
  }, ['_id', 'amountPaise', 'purpose', 'method', 'paidAt', 'status', 'idempotencyKey', 'createdBy', 'createdAt']),
  Audit: object({ action: { type: 'string' }, actorId: id, at: date, details: { type: 'object' } }),
  Trip: object({ ...timestamps, ...input(v.tripFields).properties, collectedAmountPaise: money, balanceAmountPaise: money,
    paymentStatus: { enum: ['unpaid', 'partial', 'paid'] }, payments: array(ref('Payment')), audit: array(ref('Audit')), revision: { type: 'integer' },
    source: object({ importId: id, sheet: { type: 'string' }, rowNumber: { type: 'integer' }, reviewNote: { type: 'string' }, resolutionFingerprint: { type: 'string' } }),
  }, ['_id', 'ownerId', 'customerId', 'vehicleId', 'routeName', 'startAt', 'endAt', 'totalAmountPaise', 'currency', 'status', 'collectedAmountPaise', 'balanceAmountPaise', 'paymentStatus']),
  Dashboard: object({ currency: { const: 'INR' }, timezone: { const: 'Asia/Kolkata' }, from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] },
    boundaries: object({ startInclusive: { anyOf: [date, { type: 'null' }] }, endExclusive: { anyOf: [date, { type: 'null' }] } }),
    tripCount: { type: 'integer' }, tripValuePaise: money, currentCollectionsPaise: money, currentOutstandingPaise: money,
    cancelledTripCount: { type: 'integer' }, paymentsReceivedInPeriodPaise: money, undatedCollectionsAllTripsPaise: money, cancellationTreatment: { type: 'string' },
  }),
  ImportRow: object({ sheet: { type: 'string' }, rowNumber: { type: 'integer' }, tripId: id, raw: { type: 'object', additionalProperties: true },
    proposed: { type: 'object', additionalProperties: true }, issues: array({ type: 'string' }), state: { enum: ['pending', 'committed'] }, committedTripId: { anyOf: [id, { type: 'null' }] } }),
  Import: object({ ...timestamps, fileHash: { type: 'string' }, fileName: { type: 'string' }, rows: array(ref('ImportRow')),
    totals: object({ tripCount: { type: 'integer' }, totalAmountPaise: money, rawAdvancePaise: money, rawReceivedPaise: money, rawListedBalancePaise: money }),
    approvedTotals: object({ tripCount: { type: 'integer' }, totalAmountPaise: money, collectedAmountPaise: money, balanceAmountPaise: money }) }),
};
const paths: Json = {};
const pathId = (name = 'id') => ({ name, in: 'path', required: true, schema: id });
const query = (name: string, schema: Json, description?: string) => ({ name, in: 'query', schema, description });
const pages = [query('page', { type: 'integer', minimum: 1, maximum: 100000, default: 1 }), query('pageSize', { type: 'integer', minimum: 1, maximum: 100, default: 20 })];
const period = ['from', 'to'].map(name => query(name, { type: 'string', format: 'date' }, 'Inclusive Asia/Kolkata calendar date. Omit for no bound.'));
const response = (schema: Json, description = 'Success') => ({ description, content: { 'application/json': { schema } } });
const errors = Object.fromEntries([400, 401, 404, 409, 413, 422, 500].map(status => [status, response(ref('Error'), `Error (${status}); actionable code and message`)]));
function operation(path: string, method: string, summary: string, output: Json, options: Json = {}) {
  const { input: requestSchema, status = 200, ...rest } = options;
  paths[path] ??= {};
  paths[path][method] = { summary, operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`, responses: { ...errors, [status]: response(output) },
    ...(requestSchema ? { requestBody: { required: true, content: { 'application/json': { schema: ref(requestSchema) } } } } : {}), ...rest };
}
operation('/health', 'get', 'Database connectivity health', object({ status: { enum: ['ok', 'unavailable'] } }), { security: [], responses: { 200: response(object({ status: { const: 'ok' } })), 503: response(object({ status: { const: 'unavailable' } })) } });
operation('/auth/login', 'post', 'Login with bootstrapped owner credentials', envelope(object({ accessToken: { type: 'string' }, tokenType: { const: 'Bearer' }, expiresIn: { type: 'integer' } })), { input: 'LoginInput', security: [] });
for (const [path, model] of [['customers', 'Customer'], ['vehicles', 'Vehicle']]) {
  operation(`/${path}`, 'post', `Create ${model.toLowerCase()}`, envelope(ref(model)), { input: `${model}Input`, status: 201 });
  operation(`/${path}`, 'get', `List ${path}`, list(ref(model)), { parameters: pages, description: 'Sorted by createdAt descending, then _id descending.' });
  operation(`/${path}/{id}`, 'get', `Get ${model.toLowerCase()}`, envelope(ref(model)), { parameters: [pathId()] });
  operation(`/${path}/{id}`, 'patch', `Update ${model.toLowerCase()}`, envelope(ref(model)), { input: `${model}Patch`, parameters: [pathId()] });
}
operation('/trips', 'post', 'Create trip with protected vehicle booking', envelope(ref('Trip')), { input: 'TripInput', status: 201 });
operation('/trips', 'get', 'List trips with calculated financial status', list(ref('Trip')), { parameters: [...pages, ...period,
  query('customerId', id), query('vehicleId', id), query('status', { enum: ['booked', 'ongoing', 'completed', 'cancelled'] }), query('paymentStatus', { enum: ['unpaid', 'partial', 'paid'] })],
  description: 'Sorted by startAt descending, then _id descending. List items omit payments and audit; use trip detail or payment listing.' });
operation('/trips/{id}', 'get', 'Get trip, ledger and audit history', envelope(ref('Trip')), { parameters: [pathId()] });
operation('/trips/{id}', 'patch', 'Update trip with a mandatory audit reason', envelope(ref('Trip')), { input: 'TripPatch', parameters: [pathId()] });
const payResult = object({ data: ref('Payment'), replayed: { type: 'boolean' } }, ['data', 'replayed']);
operation('/trips/{id}/payments', 'post', 'Record one actual payment', payResult, { input: 'PaymentInput', status: 201,
  parameters: [pathId(), { name: 'Idempotency-Key', in: 'header', required: true, schema: input(v.idempotencyKey) }],
  responses: { ...errors, 201: response(payResult, 'Created'), 200: response(payResult, 'Identical retry; same ledger entry (current void status)') },
  description: 'Keys are trip-scoped. Reuse with a different normalized payload returns 409. Use null paidAt only through reviewed historical imports.' });
operation('/trips/{id}/payments', 'get', 'List valid and voided payments', list(ref('Payment')), { parameters: [pathId(), ...pages] });
operation('/trips/{id}/payments/{paymentId}/void', 'post', 'Void a mistaken entry; this is not a refund', envelope(ref('Payment')), { input: 'VoidInput', parameters: [pathId(), pathId('paymentId')] });
operation('/dashboard/summary', 'get', 'Trip values, current balances and dated receipts', envelope(ref('Dashboard')), { parameters: period,
  description: 'Selected trips start in the period. Current collections/balances include all valid payments against selected trips. Receipt totals include valid dated payments on ANY trip in the period. Undated collections are reported separately across ALL owner trips. Cancelled trips are included.' });
operation('/imports/preview', 'post', 'Preview workbook; create no business records', envelope(ref('Import')), {
  requestBody: { required: true, content: { 'multipart/form-data': { schema: object({ file: { type: 'string', format: 'binary' } }, ['file']) } } },
  description: 'XLSX only; 2 MiB compressed, 20 MiB expanded, 500 trip rows. Persists original bytes and review metadata. Reuploading identical bytes returns the same owner-scoped import.' });
operation('/imports/{id}', 'get', 'Get preview, pending rows and approved totals', envelope(ref('Import')), { parameters: [pathId()] });
operation('/imports/{id}/commit', 'post', 'Commit explicitly reviewed rows', object({ data: array(object({ sheet: { type: 'string' }, rowNumber: { type: 'integer' }, status: { enum: ['committed', 'pending'] },
  trip: ref('Trip'), replayed: { type: 'boolean' }, error: object({ code: { type: 'string' }, message: { type: 'string' } }) })), import: ref('Import') }), {
  input: 'ImportCommitInput', parameters: [pathId()], description: 'Each row commits independently. HTTP 200 can contain pending row-level conflicts. Review results. Retries match persisted import + sheet + row mappings. Different resolution for committed row conflicts. No automatic customer creation or payment inference.' });
operation('/openapi.json', 'get', 'OpenAPI document', { type: 'object' });

const exampleTrip = { customerId: '507f1f77bcf86cd799439011', vehicleId: '507f1f77bcf86cd799439012', routeName: 'Guntur local',
  startAt: '2026-11-02T09:00:00+05:30', endAt: '2026-11-02T18:00:00+05:30', billingUnit: 'fixed', totalAmountPaise: 200000, status: 'completed' };
schemas.TripInput.example = exampleTrip;
schemas.Trip.example = { ...exampleTrip, _id: '507f1f77bcf86cd799439013', ownerId: '507f1f77bcf86cd799439014', currency: 'INR', collectedAmountPaise: 80000,
  balanceAmountPaise: 120000, paymentStatus: 'partial', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z' };
schemas.PaymentInput.example = { amountPaise: 80000, purpose: 'advance', method: 'upi', paidAt: '2026-11-01T10:00:00+05:30', reference: 'receipt-001' };
schemas.ImportCommitInput.example = { rows: [{ sheet: 'Sheet1', rowNumber: 12, reviewed: true,
  reviewNote: 'Separate advance and remaining receipt confirmed. Payment dates and methods remain unknown. Vehicle, dates and billing confirmed.',
  trip: exampleTrip, payments: [{ amountPaise: 80000, purpose: 'advance', method: 'unknown', paidAt: null }, { amountPaise: 120000, purpose: 'final', method: 'unknown', paidAt: null }] }] };
schemas.Error.example = { error: { code: 'OVERPAYMENT', message: 'Payment exceeds the remaining balance', requestId: 'example-request-id' } };
const document = { openapi: '3.1.0', info: { title: 'Car Details API', version: '1.0.0', description: 'Local MongoDB trip and payment tracking. All business data is owner-scoped. Money is integer INR paise. Not a profit/cost accounting system.' },
  servers: [{ url: 'http://127.0.0.1:5000/api/v1' }], security: [{ bearerAuth: [] }], paths,
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas } };
await writeFile('openapi.json', JSON.stringify(document, null, 2) + '\n');
console.log('Generated openapi.json from request validators and response contracts.');
