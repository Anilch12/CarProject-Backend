import 'dotenv/config';
import { z } from 'zod';

export function config() {
  return z.object({
    MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/car_details'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    APP_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    JWT_SECRET: z.string().min(32, 'Set JWT_SECRET to at least 32 random characters'),
  }).parse(process.env);
}
