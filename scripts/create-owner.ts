import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDatabase, ensureIndexes, Owner } from '../models/index.js';

// Password is accepted through a hidden terminal prompt or an environment variable,
// never a command-line argument that would appear in process listings.
async function hiddenPassword(): Promise<string> {
  if (!stdin.isTTY) throw new Error('Set BOOTSTRAP_PASSWORD for noninteractive execution');
  stdout.write('Password (minimum 12 characters, hidden): ');
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', listener); stdout.write('\n'); };
    const listener = (chunk: string | Buffer) => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') { done(); resolve(value); return; }
        if (c === '\u0003') { done(); reject(new Error('Cancelled')); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    stdin.on('data', listener);
  });
}
try {
  const rl = createInterface({ input: stdin, output: stdout });
  const email = z.email().parse((process.env.BOOTSTRAP_EMAIL ?? await rl.question('Owner email: ')).trim().toLowerCase());
  const name = z.string().trim().min(1).max(150).parse(process.env.BOOTSTRAP_NAME ?? await rl.question('Owner name: '));
  rl.close();
  const password = z.string().min(12).max(256).parse(process.env.BOOTSTRAP_PASSWORD ?? await hiddenPassword());
  await connectDatabase(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details');
  await ensureIndexes();
  await Owner.create({ email, name, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) });
  console.log('Owner created. Use POST /api/v1/auth/login.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Owner creation failed'); process.exitCode = 1; }
finally { delete process.env.BOOTSTRAP_PASSWORD; await mongoose.disconnect(); }
