import 'dotenv/config';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import { z } from 'zod';
import { connectDatabase, ensureIndexes, Owner, Customer, Vehicle, Trip } from '../models/index.js';
import { createTrip, addPayment } from '../src/trips.js';
import { paymentCreate, tripCreate } from '../src/validation.js';

const uri = process.env.DEV_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details_dev';
if (new URL(uri).pathname !== '/car_details_dev') throw new Error('Synthetic seed only permits the car_details_dev database');
try {
  const password = z.string().min(12).max(256).parse(process.env.SEED_PASSWORD);
  await connectDatabase(uri); await ensureIndexes();
  if (await Owner.exists({ email: 'synthetic@example.test' })) throw new Error('Synthetic seed already exists; no data was overwritten');
  const owner = await Owner.create({ name: 'Synthetic Demo Owner', email: 'synthetic@example.test', passwordHash: await argon2.hash(password) });
  const customer = await Customer.create({ ownerId: owner._id, name: 'Synthetic Customer', notes: 'Synthetic development data' });
  const vehicle = await Vehicle.create({ ownerId: owner._id, registrationNumber: 'DEMO0001', displayName: 'Synthetic Vehicle' });
  const trip = await createTrip(String(owner._id), tripCreate.parse({ customerId: String(customer._id), vehicleId: String(vehicle._id),
    routeName: 'Synthetic local trip', startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T17:00:00+05:30',
    billingUnit: 'fixed', totalAmountPaise: 200000, status: 'booked' }));
  await addPayment(String(owner._id), String(trip._id), paymentCreate.parse({ amountPaise: 80000, purpose: 'advance', method: 'cash', paidAt: '2026-11-30T10:00:00+05:30' }), 'synthetic-advance');
  console.log('Synthetic data created in car_details_dev. Login: synthetic@example.test; use the supplied SEED_PASSWORD.');
} finally { await mongoose.disconnect(); }
