import type { PipelineStage } from 'mongoose';
import { Trip } from '../models/index.js';
import { dateRange } from './validation.js';
import { financialStages, oid } from './trips.js';
import { ApiError } from './errors.js';

export async function dashboard(ownerId: string, from?: string, to?: string) {
  const range = dateRange(from, to);
  const hasRange = Object.keys(range).length > 0;
  const [result] = await Trip.aggregate([
    { $match: { ownerId: oid(ownerId) } },
    { $facet: {
      selectedTrips: [
        ...(hasRange ? [{ $match: { startAt: range } }] : []), ...financialStages,
        { $group: { _id: null, tripCount: { $sum: 1 }, tripValuePaise: { $sum: '$totalAmountPaise' },
          currentCollectionsPaise: { $sum: '$collectedAmountPaise' }, currentOutstandingPaise: { $sum: '$balanceAmountPaise' },
          cancelledTripCount: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } } } },
      ],
      receipts: [
        { $unwind: '$payments' }, { $match: { 'payments.status': 'valid', 'payments.paidAt': hasRange ? range : { $ne: null } } },
        { $group: { _id: null, paymentsReceivedInPeriodPaise: { $sum: '$payments.amountPaise' } } },
      ],
      undated: [
        { $unwind: '$payments' }, { $match: { 'payments.status': 'valid', 'payments.paidAt': null } },
        { $group: { _id: null, undatedCollectionsAllTripsPaise: { $sum: '$payments.amountPaise' } } },
      ],
    } },
  ] as PipelineStage[]);
  const { _id: _ignored1, ...selected } = result.selectedTrips[0] ?? {};
  const { _id: _ignored2, ...receipts } = result.receipts[0] ?? {};
  const { _id: _ignored3, ...undated } = result.undated[0] ?? {};
  const metrics = { tripCount: 0, tripValuePaise: 0, currentCollectionsPaise: 0, currentOutstandingPaise: 0,
    cancelledTripCount: 0, paymentsReceivedInPeriodPaise: 0, undatedCollectionsAllTripsPaise: 0, ...selected, ...receipts, ...undated };
  if (Object.values(metrics).some(v => !Number.isSafeInteger(v))) throw new ApiError(422, 'REPORT_OVERFLOW', 'Report exceeds safe integer limits. Select a narrower period.');
  return { currency: 'INR', timezone: 'Asia/Kolkata', from: from ?? null, to: to ?? null,
    boundaries: { startInclusive: range.$gte ?? null, endExclusive: range.$lt ?? null },
    cancellationTreatment: 'Included in every metric; payments and balances are preserved', ...metrics };
}
