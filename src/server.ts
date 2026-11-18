import { config } from './config.js';
import { connectDatabase, ensureIndexes } from '../models/index.js';
import { createApp } from './app.js';
import mongoose from 'mongoose';

const env = config();
const host = env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
try {
  const deployment = await connectDatabase(env.MONGODB_URI);
  await ensureIndexes();
  const server = createApp().listen(env.PORT, host, () => console.log(`Car Details API: http://${host}:${env.PORT} (${deployment.type}; atomic reservations)`));
  const shutdown = () => { server.close(() => { void mongoose.disconnect().then(() => process.exit(0)); }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} catch (error) { console.error('Startup failed:', error); await mongoose.disconnect(); process.exitCode = 1; }
