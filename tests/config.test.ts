import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const validEnvironment = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://database.example/car_details',
  JWT_SECRET: randomBytes(48).toString('hex'),
  PORT: '10000',
  APP_TIMEZONE: 'Asia/Kolkata',
};

test('missing, empty and short JWT secrets explain how to fix Render configuration', () => {
  for (const JWT_SECRET of [undefined, '', 'short', ' '.repeat(48)]) {
    withEnvironment({ ...validEnvironment, JWT_SECRET }, () => {
      assert.throws(config, error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /JWT_SECRET: Set JWT_SECRET to at least 32 random characters/);
        assert.match(error.message, /On Render, open your service > Environment/);
        assert.ok(!error.message.includes(validEnvironment.MONGODB_URI));
        return true;
      });
    });
  }
});

test('production requires an explicit MongoDB URI', () => {
  withEnvironment({ ...validEnvironment, MONGODB_URI: undefined }, () => {
    assert.throws(config, /MONGODB_URI: Set MONGODB_URI to your hosted MongoDB connection string in production/);
  });
});

test('valid production configuration preserves the signing secret and Render port', () => {
  withEnvironment(validEnvironment, () => {
    const env = config();
    assert.equal(env.JWT_SECRET, validEnvironment.JWT_SECRET);
    assert.equal(config().JWT_SECRET, env.JWT_SECRET);
    assert.equal(env.MONGODB_URI, validEnvironment.MONGODB_URI);
    assert.equal(env.PORT, 10000);
  });
});

test('development retains local MongoDB and port defaults', () => {
  withEnvironment({ ...validEnvironment, NODE_ENV: 'development', MONGODB_URI: undefined, PORT: undefined }, () => {
    const env = config();
    assert.equal(env.MONGODB_URI, 'mongodb://127.0.0.1:27017/car_details');
    assert.equal(env.PORT, 5000);
  });
});
