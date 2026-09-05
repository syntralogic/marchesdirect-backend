import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { chatbot } from '../services/aiService';

const router = Router();

// The FAQ brief is explicit that public-market search must work for an
// anonymous visitor with no account, and the chatbot is the primary search
// entry point - so every route here now accepts either a logged-in user
// (req.user.companyId) or an anonymous sessionId (same getSessionId()
// pattern already used by siret.ts/opportunities.ts for anonymous SIRET
// lookups and lead capture), never requiring one specifically. mount uses
// optionalAuth (server.ts), not authenticate.
function identity(req: AuthRequest): { companyId: string | null; sessionId: string | null } {
  const companyId = req.user?.companyId || null;
  const sessionId = !companyId ? (req.body?.sessionId || (req.query.sessionId as string) || null) : null;
  return { companyId, sessionId };
}

// POST /api/chatbot/conversations - start a new conversation (optionally tied to an
// opportunity and/or the journey the user is currently in, so the chatbot can adapt
// its answers per spec section 3 ("chatbot must be aware of the user's active
// journey") - journey isn't validated against opportunity_types here since this
// is just used for tone/prioritization, not access control.
router.post('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const { topic, opportunityId, journey } = req.body;
    const { companyId, sessionId } = identity(req);

    if (!companyId && !sessionId) {
      return res.status(400).json({ error: 'sessionId is required for an anonymous conversation' });
    }

    const result = await db.query(
      `INSERT INTO chatbot_conversations (company_id, session_id, topic, context)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        companyId,
        sessionId,
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

// GET /api/chatbot/conversations - list this company's (or this anonymous
// session's) conversations
router.get('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const { companyId, sessionId } = identity(req);
    if (!companyId && !sessionId) return res.json([]);

    const result = companyId
      ? await db.query('SELECT * FROM chatbot_conversations WHERE company_id = $1 ORDER BY updated_at DESC', [companyId])
      : await db.query('SELECT * FROM chatbot_conversations WHERE session_id = $1 ORDER BY updated_at DESC', [sessionId]);
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Conversations list error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /api/chatbot/conversations/:id/messages - message history
router.get('/conversations/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { companyId, sessionId } = identity(req);
    const convCheck = companyId
      ? await db.query('SELECT id FROM chatbot_conversations WHERE id = $1 AND company_id = $2', [req.params.id, companyId])
      : await db.query('SELECT id FROM chatbot_conversations WHERE id = $1 AND session_id = $2', [req.params.id, sessionId]);
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

    const { companyId, sessionId } = identity(req);
    const response = await chatbot(req.params.id, message, companyId, sessionId);
    res.json({ response });
  } catch (err: any) {
    logger.error('Chatbot message error:', err);
    res.status(500).json({ error: err.message || 'Chatbot failed to respond' });
  }
});

export default router;
