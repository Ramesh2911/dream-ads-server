import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';

let mongod: MongoMemoryServer;
let app: import('express').Express;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { startupTimeoutMS: 120_000 } });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_ACCESS_SECRET = 'test_access';
  process.env.JWT_REFRESH_SECRET = 'test_refresh';
  const mod = await import('../src/server');
  app = mod.app;
  const { connectDB } = await import('../src/config/database');
  await connectDB();

  const { Role, ALL_PERMISSIONS } = await import('../src/models/Role');
  const { AdminUser } = await import('../src/models/AdminUser');
  const role = await Role.create({ name: 'Super Admin', permissions: ALL_PERMISSIONS, isSystem: true });
  await AdminUser.create({ email: 'admin@test.com', password: await bcrypt.hash('pass123', 10), name: 'Admin', role: role._id });
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect().catch(() => {});
  if (mongod) await mongod.stop().catch(() => {});
});

describe('Ledger service', () => {
  it('credits and debits atomically with ledger entries', async () => {
    const { applyLedger, getBalances } = await import('../src/services/ledger.service');
    const { User } = await import('../src/models/User');
    const { LedgerEntry } = await import('../src/models/LedgerEntry');

    const user = await User.create({ name: 'T', email: 't@t.com', password: 'x', referralCode: 'DT1' });
    const r1 = await applyLedger({ userId: user._id, wallet: 'video', type: 'credit', amount: 100, reason: 'watch_reward' });
    expect(r1.balance).toBe(100);

    const r2 = await applyLedger({ userId: user._id, wallet: 'video', type: 'debit', amount: 40, reason: 'withdrawal' });
    expect(r2.balance).toBe(60);

    const entries = await LedgerEntry.find({ user: user._id });
    expect(entries).toHaveLength(2);
    expect(entries[0].balanceAfter).toBe(100);
    expect(entries[1].balanceAfter).toBe(60);
  });

  it('rejects overdraft', async () => {
    const { applyLedger } = await import('../src/services/ledger.service');
    const { User } = await import('../src/models/User');
    const user = await User.create({ name: 'B', email: 'b@b.com', password: 'x', referralCode: 'DB1' });
    await expect(
      applyLedger({ userId: user._id, wallet: 'social', type: 'debit', amount: 50, reason: 'withdrawal' })
    ).rejects.toThrow('Insufficient balance');
  });
});

describe('Auth API', () => {
  it('registers and logs in a user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Alice', email: 'alice@test.com', password: 'secret1', dob: '1995-01-01', acceptTerms: true });
    expect(res.status).toBe(201);
    expect(res.body.data.tokens.access).toBeTruthy();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@test.com', password: 'secret1' });
    expect(login.status).toBe(200);
  });

  it('rejects under-18 style invalid registration without email/mobile', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', password: 'secret1', acceptTerms: true });
    expect(res.status).toBe(400);
  });
});

describe('Admin RBAC', () => {
  let token = '';

  it('admin login works', async () => {
    const res = await request(app).post('/api/admin/login').send({ email: 'admin@test.com', password: 'pass123' });
    expect(res.status).toBe(200);
    token = res.body.data.token;
  });

  it('blocks unauthenticated access', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('allows super admin dashboard', async () => {
    const res = await request(app).get('/api/admin/dashboard').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('userCount');
  });

  it('audit log records admin actions', async () => {
    const { AuditLog } = await import('../src/models/AuditLog');
    const { User } = await import('../src/models/User');
    const u = await User.findOne({ email: 'alice@test.com' });
    const res = await request(app)
      .put(`/api/admin/users/${u!._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'suspended', before: { status: 'active' }, after: { status: 'suspended' } });
    expect(res.status).toBe(200);
    const log = await AuditLog.findOne({ action: 'user.status_change' });
    expect(log).toBeTruthy();
    expect(log!.actorEmail).toBe('admin@test.com');
  });
});

describe('Video reward flow', () => {
  it('rewards coins after minimum watch time', async () => {
    const { Category } = await import('../src/models/Category');
    const { Video } = await import('../src/models/Video');
    const { User } = await import('../src/models/User');
    const cat = await Category.create({ name: 'Test', slug: 'test-' + Date.now() });
    const video = await Video.create({ title: 'V', url: 'https://x.com/v.mp4', thumbnail: 'https://x.com/t.jpg', category: cat._id, duration: 20, rewardCoins: 15, status: 'published' });

    const reg = await request(app).post('/api/auth/register').send({ name: 'Bob', email: 'bob@test.com', password: 'secret1', acceptTerms: true });
    const userToken = reg.body.data.tokens.access;

    const res = await request(app)
      .post(`/api/videos/${video._id}/view`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ watchedSeconds: 15 });
    expect(res.status).toBe(200);
    expect(res.body.data.rewarded).toBe(true);
    expect(res.body.data.coins).toBe(15);

    const bal = await request(app).get('/api/wallet/balances').set('Authorization', `Bearer ${userToken}`);
    expect(bal.body.data.video).toBe(15);
  });
});
