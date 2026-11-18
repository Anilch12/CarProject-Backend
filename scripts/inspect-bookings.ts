import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase, Trip, Vehicle } from '../models/index.js';
try {
  await connectDatabase(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details');
  let retained = 0;
  for await (const vehicle of Vehicle.find().select('+reservations').lean().cursor()) {
    for (const reservation of vehicle.reservations) {
      const trip = await Trip.findOne({ _id: reservation.tripId, ownerId: vehicle.ownerId }).lean();
      if (!trip || String(trip.reservationToken) !== String(reservation.token)) {
        retained++;
        console.log(JSON.stringify({ vehicleId: vehicle._id, ownerId: vehicle.ownerId, reservation, tripExists: !!trip,
          note: 'Retained reservation; may belong to an in-flight write. Do not remove while API writers are running.' }));
      }
    }
  }
  console.log(`${retained} retained reservations. Read-only inspection; no changes made.`);
} finally { await mongoose.disconnect(); }
