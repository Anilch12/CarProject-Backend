import 'dotenv/config';
import { z } from 'zod';

export function config() {
  const result = z.object({
    MONGODB_URI: z.string().trim().min(1, 'Set MONGODB_URI to your MongoDB connection string').optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    APP_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    JWT_SECRET: z.string({ error: 'Set JWT_SECRET to at least 32 random characters' })
      .refine(value => value.trim().length >= 32, 'Set JWT_SECRET to at least 32 random characters'),
  }).superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.MONGODB_URI) {
      ctx.addIssue({ code: 'custom', path: ['MONGODB_URI'], message: 'Set MONGODB_URI to your hosted MongoDB connection string in production' });
    }
  }).safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues.map(issue => `- ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}\nOn Render, open your service > Environment, set these variables, then Save and deploy.`);
  }

  return { ...result.data, MONGODB_URI: result.data.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/car_details' };
}
