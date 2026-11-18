import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { RequestHandler } from 'express';
import { Owner } from '../models/index.js';
import { ApiError } from './errors.js';
import { config } from './config.js';
import { objectId } from './validation.js';

declare global { namespace Express { interface Request { ownerId: string } } }
const secret = () => new TextEncoder().encode(config().JWT_SECRET);
export async function signToken(ownerId: string) {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ownerId)
    .setIssuer('car-details-api').setAudience('car-details').setIssuedAt().setExpirationTime('8h').sign(secret());
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new Error('Missing bearer token');
    const { payload } = await jwtVerify(header.slice(7), secret(), { algorithms: ['HS256'], issuer: 'car-details-api', audience: 'car-details' });
    const id = objectId.parse(payload.sub);
    if (!await Owner.exists({ _id: id, active: true })) throw new Error('Inactive owner');
    req.ownerId = id;
    next();
  } catch { next(new ApiError(401, 'UNAUTHORIZED', 'Valid bearer authentication is required')); }
};
// A fixed dummy hash is generated at process startup, so unknown email login attempts
// incur the same password hashing work without hardcoded credentials.
const dummyHash = argon2.hash('dummy-not-a-login-' + crypto.randomUUID(), { type: argon2.argon2id });
export async function login(email: string, password: string) {
  const owner = await Owner.findOne({ email, active: true }).select('+passwordHash').lean();
  const valid = await argon2.verify(owner?.passwordHash ?? await dummyHash, password);
  if (!owner || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  return { accessToken: await signToken(String(owner._id)), tokenType: 'Bearer', expiresIn: 28800 };
}
