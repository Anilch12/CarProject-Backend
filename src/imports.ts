import readExcelFile from 'read-excel-file/node';
import { validateWorkbookArchive } from './workbook-safety.js';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Customer, ImportBatch, Trip } from '../models/index.js';
import { ApiError, conflict, missing } from './errors.js';
import { commitRow, type TripInput } from './validation.js';
import { createTrip, fingerprint, oid, tripResponse } from './trips.js';

export type PreviewRow = {
  sheet: string; rowNumber: number; tripId: string; raw: Record<string, unknown>;
  proposed: Record<string, unknown>; issues: string[];
};
const headers = ['Route Name', 'Customer Name', 'Start Date & Time', 'End Date & Time', 'Trip Total Amount',
  'Advance Amount', 'Received Amount', 'Balance Amount', '12hrs/24hrs/Days'];
const normalize = (s: unknown) => String(s ?? '').trim().toLowerCase();
function rupees(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const paise = Math.round(v * 100);
  return Number.isSafeInteger(paise) && Math.abs(v * 100 - paise) < 0.00001 ? paise : null;
}
// The parser represents timezone-free Excel calendar values as Date objects in UTC.
// We expose a *candidate* Kolkata interpretation, never approval of that assumption.
function candidateDate(value: unknown) {
  if (!(value instanceof Date) || !Number.isFinite(+value)) return null;
  const rounded = new Date(Math.round(+value / 1000) * 1000);
  return rounded.toISOString().replace('Z', '+05:30');
}
export async function parseWorkbook(buffer: Buffer) {
  await validateWorkbookArchive(buffer);
  let sheets: Awaited<ReturnType<typeof readExcelFile>>;
  try { sheets = await readExcelFile(buffer, { trim: false }); }
  catch { throw new ApiError(422, 'INVALID_WORKBOOK', 'Upload a valid .xlsx workbook'); }
  const rows: PreviewRow[] = [];
  const totals = { tripCount: 0, totalAmountPaise: 0, rawAdvancePaise: 0, rawReceivedPaise: 0, rawListedBalancePaise: 0 };
  for (const sheet of sheets) {
    let columns: number[] | undefined;
    sheet.data.forEach((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      if (!columns) {
        const values = row.map(normalize);
        if (values.includes('route name') && values.includes('customer name')) {
          const mapped = headers.map(h => values.indexOf(h.toLowerCase()));
          if (mapped.some(i => i < 0)) throw new ApiError(422, 'MISSING_COLUMNS', `Sheet ${sheet.sheet} is missing required columns`);
          columns = mapped;
        }
        return;
      }
      const values = columns.map(c => row[c] ?? null);
      const routeName = String(values[0] ?? '').trim();
      const customerName = String(values[1] ?? '').trim();
      if ((!routeName && !customerName) || /^(grand\s+total|total|summary)$/i.test(routeName)) return;
      if (rows.length >= 500) throw new ApiError(422, 'IMPORT_TOO_LARGE', 'Maximum 500 trip rows per import');
      const issues = ['MISSING_VEHICLE', 'CONFIRM_TIMEZONE', 'REVIEW_CUSTOMER_IDENTITY'];
      const raw = Object.fromEntries(headers.map((h, i) => [h, values[i] instanceof Date ? { excelCalendarValue: values[i].toISOString().replace('Z', ''), timezone: 'unspecified' } : values[i]]));
      const startAt = candidateDate(values[2]), endAt = candidateDate(values[3]);
      if (!startAt || !endAt) issues.push('INVALID_OR_AMBIGUOUS_DATE');
      if (startAt && endAt && new Date(endAt) <= new Date(startAt)) issues.push('END_BEFORE_START');
      const totalAmountPaise = rupees(values[4]);
      const advancePaise = rupees(values[5]), receivedPaise = rupees(values[6]), listedBalancePaise = rupees(values[7]);
      if ([totalAmountPaise, advancePaise, receivedPaise, listedBalancePaise].some(v => v === null)) issues.push('INVALID_OR_MISSING_AMOUNT');
      if (advancePaise) issues.push('AMBIGUOUS_ADVANCE_RECEIVED');
      if ((advancePaise ?? 0) + (receivedPaise ?? 0) > 0) issues.push('MISSING_PAYMENT_DATES', 'MISSING_PAYMENT_METHODS');
      if (advancePaise === 0 && totalAmountPaise !== null && receivedPaise !== null && listedBalancePaise !== null && totalAmountPaise - receivedPaise !== listedBalancePaise) issues.push('BALANCE_MISMATCH');
      const unit = normalize(values[8]);
      const unitMap: Record<string, string> = { '12hrs': '12_hours', '12 hours': '12_hours', '24hrs': '24_hours', '24 hours': '24_hours', days: 'day', day: 'day', fixed: 'fixed' };
      const billingUnit = unitMap[unit] ?? null;
      if (!billingUnit) issues.push(unit ? 'UNKNOWN_BILLING_UNIT' : 'MISSING_BILLING_UNIT');
      if (!routeName || !customerName) issues.push('MISSING_ROUTE_OR_CUSTOMER');
      rows.push({ sheet: sheet.sheet, rowNumber, tripId: String(new Types.ObjectId()), raw,
        proposed: { routeName, customerName, startAt, endAt, totalAmountPaise, advancePaise, receivedPaise, listedBalancePaise,
          billingUnit, vehicleId: null, customerId: null, payments: null }, issues });
      totals.tripCount++;
      totals.totalAmountPaise += totalAmountPaise ?? 0;
      totals.rawAdvancePaise += advancePaise ?? 0;
      totals.rawReceivedPaise += receivedPaise ?? 0;
      totals.rawListedBalancePaise += listedBalancePaise ?? 0;
    });
  }
  if (!rows.length) throw new ApiError(422, 'NO_TRIP_ROWS', 'No trip rows found beneath the expected column headers');
  for (const row of rows) {
    for (const other of rows) {
      if (row === other) continue;
      if (normalize(row.proposed.customerName) === normalize(other.proposed.customerName)) row.issues.push('POSSIBLE_DUPLICATE_CUSTOMER');
      if (normalize(row.proposed.routeName) === normalize(other.proposed.routeName) && row.proposed.startAt && row.proposed.startAt === other.proposed.startAt) row.issues.push('POSSIBLE_DUPLICATE_TRIP');
      if (row.proposed.startAt && row.proposed.endAt && other.proposed.startAt && other.proposed.endAt &&
        +new Date(String(row.proposed.startAt)) < +new Date(String(other.proposed.endAt)) &&
        +new Date(String(row.proposed.endAt)) > +new Date(String(other.proposed.startAt))) row.issues.push('POTENTIAL_BOOKING_OVERLAP');
    }
    row.issues = [...new Set(row.issues)];
  }
  if (Object.values(totals).some(v => !Number.isSafeInteger(v))) throw new ApiError(422, 'AMOUNT_OVERFLOW', 'Workbook totals exceed safe integer limits');
  return { rows, totals };
}

export async function previewImport(ownerId: string, fileName: string, buffer: Buffer) {
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const existing = await ImportBatch.findOne({ ownerId: oid(ownerId), fileHash }).lean();
  if (existing) return importView(ownerId, String(existing._id));
  const parsed = await parseWorkbook(buffer);
  // Keep the persisted preview below MongoDB's document limit even with verbose cells.
  if (Buffer.byteLength(JSON.stringify(parsed)) > 4 * 1024 * 1024) throw new ApiError(422, 'IMPORT_TOO_LARGE', 'Decoded preview exceeds 4 MiB');
  for (const row of parsed.rows) {
    const escapedName = String(row.proposed.customerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const customerMatches = await Customer.find({ ownerId: oid(ownerId), name: { $regex: `^${escapedName}$`, $options: 'i' } }).select('_id name').limit(20).lean();
    if (customerMatches.length) { row.issues.push('POSSIBLE_EXISTING_CUSTOMER'); row.proposed.customerCandidates = customerMatches; }
    if (row.proposed.startAt) {
      const matches = await Trip.find({ ownerId: oid(ownerId), routeName: String(row.proposed.routeName),
        startAt: new Date(String(row.proposed.startAt)) }).select('_id routeName startAt').limit(20).lean();
      if (matches.length) { row.issues.push('POSSIBLE_EXISTING_TRIP'); row.proposed.tripCandidates = matches; }
    }
  }
  let batch;
  try { batch = await ImportBatch.create({ ownerId: oid(ownerId), fileHash, fileName, originalFile: buffer, ...parsed }); }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    batch = await ImportBatch.findOne({ ownerId: oid(ownerId), fileHash });
  }
  return importView(ownerId, String(batch!._id));
}
export async function importView(ownerId: string, id: string) {
  const batch = await ImportBatch.findOne({ _id: oid(id), ownerId: oid(ownerId) }).lean();
  if (!batch) missing();
  const trips = await Trip.find({ ownerId: oid(ownerId), 'source.importId': batch._id }).lean();
  const mapped = new Map(trips.map(t => [`${t.source!.sheet}:${t.source!.rowNumber}`, t]));
  return { ...batch, rows: (batch.rows as PreviewRow[]).map(row => ({ ...row,
    state: mapped.has(`${row.sheet}:${row.rowNumber}`) ? 'committed' : 'pending',
    committedTripId: mapped.get(`${row.sheet}:${row.rowNumber}`)?._id ?? null,
  })), approvedTotals: trips.reduce((a, t) => {
    const view = tripResponse(t);
    a.tripCount++; a.totalAmountPaise += t.totalAmountPaise;
    a.collectedAmountPaise += view.collectedAmountPaise; a.balanceAmountPaise += view.balanceAmountPaise;
    return a;
  }, { tripCount: 0, totalAmountPaise: 0, collectedAmountPaise: 0, balanceAmountPaise: 0 }) };
}
export async function commitImportRow(ownerId: string, id: string, resolution: z.infer<typeof commitRow>) {
  const batch = await ImportBatch.findOne({ _id: oid(id), ownerId: oid(ownerId) }).lean();
  if (!batch) missing();
  const row = (batch.rows as PreviewRow[]).find(r => r.sheet === resolution.sheet && r.rowNumber === resolution.rowNumber);
  if (!row) throw new ApiError(422, 'UNKNOWN_IMPORT_ROW', 'Row is not part of this preview');
  const digest = fingerprint(resolution);
  const findExisting = () => Trip.findOne({ ownerId: oid(ownerId), 'source.importId': batch._id,
    'source.sheet': row.sheet, 'source.rowNumber': row.rowNumber }).lean();
  const replay = (existing: NonNullable<Awaited<ReturnType<typeof findExisting>>>) => {
    if (existing.source!.resolutionFingerprint !== digest) conflict('IMPORT_RESOLUTION_CONFLICT', 'This row was committed with a different resolution; edit the trip through the normal audited API');
    return { trip: tripResponse(existing), replayed: true };
  };
  const existing = await findExisting();
  if (existing) return replay(existing);
  try {
    const trip = await createTrip(ownerId, resolution.trip as TripInput, { id: oid(row.tripId), payments: resolution.payments,
      source: { importId: batch._id, sheet: row.sheet, rowNumber: row.rowNumber, resolutionFingerprint: digest, reviewNote: resolution.reviewNote } });
    return { trip, replayed: false };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const winner = await findExisting();
    if (!winner) throw error;
    return replay(winner);
  }
}
