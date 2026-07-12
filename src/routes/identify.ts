import { Router, Request, Response } from 'express';
import { identify, BadRequestError } from '../identify';

export const identifyRouter = Router();

identifyRouter.post('/identify', async (req: Request, res: Response) => {
  try {
    const { email, phoneNumber } = req.body ?? {};
    const result = await identify({ email, phoneNumber });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof BadRequestError) {
      return res.status(400).json({ error: err.message });
    }
    // Deliberately generic in production: avoid leaking internals to the client.
    console.error('Unhandled /identify error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
