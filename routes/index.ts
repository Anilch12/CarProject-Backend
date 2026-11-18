import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { authenticate } from '../src/auth.js';
import { ApiError } from '../src/errors.js';
import * as controller from '../controllers/index.js';

export function createApiRouter() {
  const api = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 },
    fileFilter: (_req, file, cb) => { if (!file.originalname.toLowerCase().endsWith('.xlsx')) cb(new ApiError(422, 'INVALID_WORKBOOK', 'Only .xlsx files are accepted')); else cb(null, true); } });
  api.get('/health', controller.health);
  api.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Retry later.' } } }), controller.signIn);
  api.use(authenticate);
  api.get('/openapi.json', controller.openApi);
  api.post('/customers', controller.createCustomer);
  api.get('/customers', controller.listCustomers);
  api.get('/customers/:id', controller.getCustomer);
  api.patch('/customers/:id', controller.updateCustomer);
  api.post('/vehicles', controller.createVehicle);
  api.get('/vehicles', controller.listVehicles);
  api.get('/vehicles/:id', controller.getVehicle);
  api.patch('/vehicles/:id', controller.updateVehicle);
  api.post('/trips', controller.createTrip);
  api.get('/trips', controller.listTrips);
  api.get('/trips/:id', controller.getTrip);
  api.patch('/trips/:id', controller.updateTrip);
  api.post('/trips/:id/payments', controller.createPayment);
  api.get('/trips/:id/payments', controller.listPayments);
  api.post('/trips/:id/payments/:paymentId/void', controller.voidPayment);
  api.get('/dashboard/summary', controller.dashboardSummary);
  api.post('/imports/preview', upload.single('file'), controller.previewImport);
  api.get('/imports/:id', controller.getImport);
  api.post('/imports/:id/commit', controller.commitImport);
  return api;
}
