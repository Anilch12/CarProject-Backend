import type { RequestHandler } from 'express';
import mongoose, { type PipelineStage } from 'mongoose';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { login } from '../src/auth.js';
import { Customer, Vehicle, Trip } from '../models/index.js';
import * as v from '../src/validation.js';
import { ApiError, missing } from '../src/errors.js';
import { addPayment, createTrip as saveTrip, financialStages, getTrip as findTrip, oid, patchTrip, tripResponse, voidPayment as voidReceipt } from '../src/trips.js';
import { dashboard } from '../src/reporting.js';
import { commitImportRow, importView, previewImport as inspectImport } from '../src/imports.js';

export const health: RequestHandler = async (_req, res) => {
  try { await mongoose.connection.db!.admin().ping(); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
};

export const signIn: RequestHandler = async (req, res) => {
  const input = v.loginInput.parse(req.body);
  res.json({ data: await login(input.email, input.password) });
};

export const openApi: RequestHandler = async (_req, res) => {
  res.type('application/json').send(await readFile(resolve('openapi.json'), 'utf8'));
};

export const createCustomer: RequestHandler = async (req, res) => {
  const input = v.customerCreate.parse(req.body);
  res.status(201).json({ data: await Customer.create({ ...input, ownerId: oid(req.ownerId) }) });
};

export const listCustomers: RequestHandler = async (req, res) => {
  const { page, pageSize } = v.pagination.strict().parse(req.query);
  const filter = { ownerId: oid(req.ownerId) };
  const [data, total] = await Promise.all([Customer.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Customer.countDocuments(filter)]);
  res.json({ data, pagination: { page, pageSize, total } });
};

export const getCustomer: RequestHandler = async (req, res) => {
  const data = await Customer.findOne({ _id: v.objectId.parse(req.params.id), ownerId: oid(req.ownerId) }).lean();
  if (!data) missing(); res.json({ data });
};

export const updateCustomer: RequestHandler = async (req, res) => {
  const data = await Customer.findOneAndUpdate({ _id: v.objectId.parse(req.params.id), ownerId: oid(req.ownerId) },
    { $set: v.customerPatch.parse(req.body) }, { returnDocument: 'after', runValidators: true }).lean();
  if (!data) missing(); res.json({ data });
};

export const createVehicle: RequestHandler = async (req, res) => {
  const input = v.vehicleCreate.parse(req.body);
  res.status(201).json({ data: await Vehicle.create({ ...input, ownerId: oid(req.ownerId) }) });
};

export const listVehicles: RequestHandler = async (req, res) => {
  const { page, pageSize } = v.pagination.strict().parse(req.query);
  const filter = { ownerId: oid(req.ownerId) };
  const [data, total] = await Promise.all([Vehicle.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Vehicle.countDocuments(filter)]);
  res.json({ data, pagination: { page, pageSize, total } });
};

export const getVehicle: RequestHandler = async (req, res) => {
  const data = await Vehicle.findOne({ _id: v.objectId.parse(req.params.id), ownerId: oid(req.ownerId) }).lean();
  if (!data) missing(); res.json({ data });
};

export const updateVehicle: RequestHandler = async (req, res) => {
  const data = await Vehicle.findOneAndUpdate({ _id: v.objectId.parse(req.params.id), ownerId: oid(req.ownerId) },
    { $set: v.vehiclePatch.parse(req.body) }, { returnDocument: 'after', runValidators: true }).lean();
  if (!data) missing(); res.json({ data });
};

export const createTrip: RequestHandler = async (req, res) => { res.status(201).json({ data: await saveTrip(req.ownerId, v.tripCreate.parse(req.body)) }); };

export const listTrips: RequestHandler = async (req, res) => {
  const query = v.tripQuery.parse(req.query);
  const { page, pageSize } = query;
  const filter: Record<string, unknown> = { ownerId: oid(req.ownerId) };
  if (query.customerId) filter.customerId = oid(query.customerId);
  if (query.vehicleId) filter.vehicleId = oid(query.vehicleId);
  if (query.status) filter.status = query.status;
  if (query.from || query.to) filter.startAt = v.dateRange(query.from, query.to);
  const [result] = await Trip.aggregate([
    { $match: filter }, ...financialStages,
    ...(query.paymentStatus ? [{ $match: { paymentStatus: query.paymentStatus } }] : []),
    { $facet: { data: [{ $sort: { startAt: -1, _id: -1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize },
      { $project: { reservationToken: 0, audit: 0, payments: 0 } }], count: [{ $count: 'total' }] } },
  ] as PipelineStage[]);
  res.json({ data: result.data, pagination: { page, pageSize, total: result.count[0]?.total ?? 0 } });
};

export const getTrip: RequestHandler = async (req, res) => { res.json({ data: tripResponse(await findTrip(req.ownerId, v.objectId.parse(req.params.id))) }); };

export const updateTrip: RequestHandler = async (req, res) => {
  res.json({ data: await patchTrip(req.ownerId, v.objectId.parse(req.params.id), v.tripPatch.parse(req.body)) });
};

export const createPayment: RequestHandler = async (req, res) => {
  const key = v.idempotencyKey.parse(req.headers['idempotency-key']);
  const result = await addPayment(req.ownerId, v.objectId.parse(req.params.id), v.paymentCreate.parse(req.body), key);
  res.status(result.replayed ? 200 : 201).json({ data: result.payment, replayed: result.replayed });
};

export const listPayments: RequestHandler = async (req, res) => {
  const { page, pageSize } = v.pagination.strict().parse(req.query);
  const trip = await findTrip(req.ownerId, v.objectId.parse(req.params.id));
  const payments = trip.payments.sort((a, b) => +b.createdAt - +a.createdAt || String(b._id).localeCompare(String(a._id)));
  res.json({ data: payments.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: payments.length } });
};

export const voidPayment: RequestHandler = async (req, res) => {
  const input = v.voidInput.parse(req.body);
  res.json({ data: await voidReceipt(req.ownerId, v.objectId.parse(req.params.id), v.objectId.parse(req.params.paymentId), input.reason) });
};

export const dashboardSummary: RequestHandler = async (req, res) => {
  const query = v.period.strict().parse(req.query);
  res.json({ data: await dashboard(req.ownerId, query.from, query.to) });
};

export const previewImport: RequestHandler = async (req, res) => {
  if (!req.file) throw new ApiError(422, 'FILE_REQUIRED', 'Send the workbook as multipart field file');
  res.status(200).json({ data: await inspectImport(req.ownerId, req.file.originalname, req.file.buffer) });
};

export const getImport: RequestHandler = async (req, res) => { res.json({ data: await importView(req.ownerId, v.objectId.parse(req.params.id)) }); };

export const commitImport: RequestHandler = async (req, res) => {
  const id = v.objectId.parse(req.params.id), input = v.commitInput.parse(req.body);
  await importView(req.ownerId, id); // Check ownership before processing individual rows.
  const results = [];
  for (const row of input.rows) {
    try { results.push({ sheet: row.sheet, rowNumber: row.rowNumber, status: 'committed', ...await commitImportRow(req.ownerId, id, row) }); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      results.push({ sheet: row.sheet, rowNumber: row.rowNumber, status: 'pending', error: { code: error.code, message: error.message } });
    }
  }
  res.json({ data: results, import: await importView(req.ownerId, id) });
};

