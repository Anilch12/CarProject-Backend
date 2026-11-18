import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { createApiRouter } from '../routes/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(helmet());
  app.use((req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader('X-Request-Id', res.locals.requestId); next(); });
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', async (_req, res) => {
    try {
      await mongoose.connection.db!.admin().ping();
      res.json({ status: 'ok', database: 'reachable', bookingProtection: 'atomic-vehicle-reservations' });
    } catch { res.status(503).json({ status: 'unavailable', database: 'unreachable' }); }
  });
  app.use('/api/v1', createApiRouter());
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found')));
  const handler: ErrorRequestHandler = (error, _req, res, _next) => {
    let status = 500, code = 'INTERNAL_ERROR', message = 'Unexpected server error; retry or contact the administrator', details;
    if (error instanceof ZodError) { status = 422; code = 'VALIDATION_ERROR'; message = 'Correct the invalid input fields'; details = error.issues.map(i => ({ path: i.path.join('.'), message: i.message })); }
    else if (error instanceof ApiError) { ({ status, code, message, details } = error); }
    else if (error instanceof multer.MulterError) { status = 422; code = 'UPLOAD_ERROR'; message = error.message; }
    else if (error?.code === 11000) { status = 409; code = 'DUPLICATE_RECORD'; message = 'A record with this unique identifier already exists'; }
    else if (error?.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Malformed JSON body'; }
    else if (error?.type === 'entity.too.large') { status = 413; code = 'REQUEST_TOO_LARGE'; message = 'Request exceeds the size limit'; }
    if (status === 500) console.error({ requestId: res.locals.requestId, error });
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: res.locals.requestId } });
  };
  app.use(handler);
  return app;
}
