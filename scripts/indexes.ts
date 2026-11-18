import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase, ensureIndexes } from '../models/index.js';
try {
  console.log(await connectDatabase(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details'));
  await ensureIndexes();
  console.log('Required indexes created. Existing indexes and documents were not removed.');
} finally { await mongoose.disconnect(); }
