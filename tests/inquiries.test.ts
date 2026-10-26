import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';

let mongod: MongoMemoryServer;
let app: import('express').Express;
let token = '';

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
  const admin = await AdminUser.create({
    email: 'leads@test.com',
    password: await bcrypt.hash('pass123', 10),
    name: 'Leads Admin',
    role: role._id,
  });
  const { signAccessToken } = await import('../src/middleware/auth');
  token = signAccessToken(String(admin._id));
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect().catch(() => {});
  if (mongod) await mongod.stop().catch(() => {});
});

const validBody = {
  name: 'Test Client',
  email: 'client@example.com',
  subject: 'project',
  service: 'Web Application Engineering',
  message: 'We need a SaaS portal for our operations team with role-based dashboards.',
  source: 'corporate',
};

describe('Inquiries (corporate contact form → admin leads)', () => {
  it('accepts a public inquiry and returns 201', async () => {
    const res = await request(app).post('/api/inquiries').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('new');
  });

  it('rejects short messages with validation error', async () => {
    const res = await request(app).post('/api/inquiries').send({ ...validBody, message: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('stores calculator estimate payload when provided', async () => {
    const res = await request(app)
      .post('/api/inquiries')
      .send({
        ...validBody,
        email: 'est@example.com',
        estimate: { platform: 'web-app', features: ['auth', 'admin'], timeline: 'standard', complexity: 2 },
      });
    expect(res.status).toBe(201);

    const list = await request(app)
      .get('/api/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .query({ search: 'est@example.com' });
    expect(list.status).toBe(200);
    const item = list.body.data.items[0];
    expect(item.estimate.platform).toBe('web-app');
    expect(item.estimate.features).toEqual(['auth', 'admin']);
  });

  it('requires authentication to list inquiries', async () => {
    const res = await request(app).get('/api/inquiries');
    expect(res.status).toBe(401);
  });

  it('lists inquiries for admin with leads.read', async () => {
    const res = await request(app).get('/api/inquiries').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('filters by status and search', async () => {
    const res = await request(app)
      .get('/api/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .query({ status: 'new', search: 'client@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.items[0].email).toBe('client@example.com');
  });

  it('updates status and adds an internal note (leads.manage)', async () => {
    const list = await request(app)
      .get('/api/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .query({ search: 'client@example.com' });
    const id = list.body.data.items[0]._id;

    const res = await request(app)
      .put(`/api/inquiries/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'contacted', note: 'Called the client, demo scheduled.' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('contacted');
    expect(res.body.data.notes).toHaveLength(1);
    expect(res.body.data.notes[0].body).toContain('demo scheduled');
  });

  it('rejects invalid status transitions', async () => {
    const list = await request(app)
      .get('/api/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .query({ search: 'client@example.com' });
    const id = list.body.data.items[0]._id;

    const res = await request(app)
      .put(`/api/inquiries/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'not-a-status' });
    expect(res.status).toBe(400);
  });

  it('404s for unknown inquiry id', async () => {
    const res = await request(app)
      .get('/api/inquiries/000000000000000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
