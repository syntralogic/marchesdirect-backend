import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { chatbot } from '../services/aiService';

const router = Router();

// POST /api/chatbot/conversations - start a new conversation (optionally tied to an
// opportunity and/or the journey the user is currently in, so the chatbot can adapt
// its answers per spec section 3 ("chatbot must be aware of the user's active
// journey") - journey isn't validated against opportunity_types here since this
// is just used for tone/prioritization, not access control.
router.post('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const { topic, opportunityId, journey } = req.body;

    const result = await db.query(
      `INSERT INTO chatbot_conversations (company_id, topic, context)
       VALUES ($1, $2, $3) RETURNING *`,
      [
        req.user!.companyId,
        topic || 'general',
        JSON.stringify({
          ...(opportunityId ? { opportunity_id: opportunityId } : {}),
          ...(journey ? { journey } : {}),
        }),
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    logger.error('Conversation create error:', err);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

// GET /api/chatbot/conversations - list this company's conversations
router.get('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM chatbot_conversations WHERE company_id = $1 ORDER BY updated_at DESC',
      [req.user!.companyId]
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Conversations list error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /api/chatbot/conversations/:id/messages - message history
router.get('/conversations/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const convCheck = await db.query(
      'SELECT id FROM chatbot_conversations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user!.companyId]
    );
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const result = await db.query(
      'SELECT * FROM chatbot_messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Messages fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/chatbot/conversations/:id/messages - send a message, get AI response
router.post('/conversations/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await chatbot(req.params.id, message, req.user!.companyId);
    res.json({ response });
  } catch (err: any) {
    logger.error('Chatbot message error:', err);
    res.status(500).json({ error: err.message || 'Chatbot failed to respond' });
  }
});

export default router;
