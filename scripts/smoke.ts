import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { connectDatabase } from '../models/index.js';

// Uses a newly named test database and never reads the configured application URI.
const uri = new URL(process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details_test');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) || !/^\/car_details_test(?:_[a-zA-Z0-9]+)*$/.test(uri.pathname)) throw new Error('Smoke test requires a local car_details_test database');
const database = `car_details_test_smoke_${randomBytes(12).toString('hex')}`;
uri.pathname = `/${database}`;
await connectDatabase(uri.toString());
if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error('Refusing existing database');
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, MONGODB_URI: uri.toString(),
  JWT_SECRET: randomBytes(48).toString('hex'), PORT: '5099', NODE_ENV: 'production' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', b => { output += b.toString(); });
server.stderr.on('data', b => { output += b.toString(); });
try {
  const deadline = Date.now() + 15000;
  while (!output.includes('Car Details API:')) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Server startup failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!output.includes('http://0.0.0.0:5099')) throw new Error('Production server must bind to 0.0.0.0 and use the configured PORT');
  const health = await fetch('http://127.0.0.1:5099/health');
  if (health.status !== 200 || (await health.json() as { status: string }).status !== 'ok') throw new Error('Health check failed');
  if ((await fetch('http://127.0.0.1:5099/api/v1/trips')).status !== 401) throw new Error('Authentication not enforced');
  console.log('Compiled server smoke passed: production public interface, configured PORT, database connection, indexes, health and authentication.');
} finally {
  if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  if (mongoose.connection.name === database) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
