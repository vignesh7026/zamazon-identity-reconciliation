process.env.DATABASE_URL = ':memory:';

import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';

// Fresh table before every test so each case starts from a known state.
beforeEach(() => {
  db.exec('DELETE FROM contacts;');
});

afterAll(() => {
  db.close();
});

describe('POST /identify', () => {
  it('creates a brand new primary contact when nothing matches', async () => {
    const res = await request(app)
      .post('/identify')
      .send({ email: 'doc@delorean.com', phoneNumber: '1000000000' });

    expect(res.status).toBe(200);
    expect(res.body.contact.emails).toEqual(['doc@delorean.com']);
    expect(res.body.contact.phoneNumbers).toEqual(['1000000000']);
    expect(res.body.contact.secondaryContactIds).toEqual([]);
  });

  it('creates a secondary contact when the request adds a new email to a known phone number', async () => {
    const first = await request(app)
      .post('/identify')
      .send({ email: 'doc@delorean.com', phoneNumber: '1000000000' });
    const primaryId = first.body.contact.primaryContactId;

    const second = await request(app)
      .post('/identify')
      .send({ email: 'marty@delorean.com', phoneNumber: '1000000000' });

    expect(second.status).toBe(200);
    expect(second.body.contact.primaryContactId).toBe(primaryId);
    expect(second.body.contact.emails).toEqual(['doc@delorean.com', 'marty@delorean.com']);
    expect(second.body.contact.phoneNumbers).toEqual(['1000000000']);
    expect(second.body.contact.secondaryContactIds.length).toBe(1);
  });

  it('does not create a duplicate row for an already-known email+phone pair', async () => {
    await request(app)
      .post('/identify')
      .send({ email: 'doc@delorean.com', phoneNumber: '1000000000' });

    const repeat = await request(app)
      .post('/identify')
      .send({ email: 'doc@delorean.com', phoneNumber: '1000000000' });

    expect(repeat.body.contact.secondaryContactIds).toEqual([]);
  });

  it('merges two previously separate primary contacts when a request bridges them', async () => {
    const a = await request(app)
      .post('/identify')
      .send({ email: 'doc@delorean.com', phoneNumber: '1000000000' });

    // wait a tick so createdAt ordering between the two primaries is stable
    await new Promise((r) => setTimeout(r, 5));

    const b = await request(app)
      .post('/identify')
      .send({ email: 'einstein@delorean.com', phoneNumber: '2000000000' });

    // Bridge request: shares phone with A, shares email with B.
    const bridge = await request(app)
      .post('/identify')
      .send({ email: 'einstein@delorean.com', phoneNumber: '1000000000' });

    expect(bridge.status).toBe(200);
    // The older contact (a) must remain primary; b becomes secondary.
    expect(bridge.body.contact.primaryContactId).toBe(a.body.contact.primaryContactId);
    expect(bridge.body.contact.secondaryContactIds).toContain(b.body.contact.primaryContactId);
    expect(bridge.body.contact.emails).toEqual(
      expect.arrayContaining(['doc@delorean.com', 'einstein@delorean.com'])
    );
    expect(bridge.body.contact.phoneNumbers).toEqual(
      expect.arrayContaining(['1000000000', '2000000000'])
    );
  });

  it('rejects a request with neither email nor phoneNumber', async () => {
    const res = await request(app).post('/identify').send({});
    expect(res.status).toBe(400);
  });

  it('handles a request with only an email, matching an existing contact by email alone', async () => {
    const a = await request(app)
      .post('/identify')
      .send({ email: 'doc@delorean.com', phoneNumber: '1000000000' });

    const res = await request(app).post('/identify').send({ email: 'doc@delorean.com' });

    expect(res.status).toBe(200);
    expect(res.body.contact.primaryContactId).toBe(a.body.contact.primaryContactId);
    expect(res.body.contact.secondaryContactIds).toEqual([]);
  });

  it('rejects malformed JSON with a generic error, not a raw parser message', async () => {
    const res = await request(app)
      .post('/identify')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    // must not leak parser internals like byte offsets or the raw body
    expect(JSON.stringify(res.body)).not.toMatch(/position|SyntaxError|Unexpected token/i);
  });

  it('rejects a non-string email instead of silently coercing it', async () => {
    const res = await request(app)
      .post('/identify')
      .send({ email: { nested: 'object' }, phoneNumber: '1000000000' });

    expect(res.status).toBe(400);
  });

  it('rejects an email exceeding the maximum allowed length', async () => {
    const tooLong = 'a'.repeat(321) + '@example.com';
    const res = await request(app).post('/identify').send({ email: tooLong });

    expect(res.status).toBe(400);
  });

  it('does not expose the underlying framework via the X-Powered-By header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('treats whitespace-only fields as absent, not as a valid identifier', async () => {
    const res = await request(app).post('/identify').send({ email: '   ', phoneNumber: '   ' });
    expect(res.status).toBe(400);
  });

  it('does not create duplicate primaries when identical requests race each other', async () => {
    // Fire the same brand-new identity at the service concurrently. Without
    // the transaction wrapping in identify.ts, both could read "no matches"
    // before either had written its row, producing two separate primaries
    // for what should be one person.
    const payload = { email: 'race@delorean.com', phoneNumber: '3000000000' };
    const [a, b] = await Promise.all([
      request(app).post('/identify').send(payload),
      request(app).post('/identify').send(payload),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both requests must resolve to the *same* primary contact.
    expect(a.body.contact.primaryContactId).toBe(b.body.contact.primaryContactId);
  });
});
