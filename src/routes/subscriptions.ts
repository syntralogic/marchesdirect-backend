import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2023-10-16' }) : null;

// GET /api/subscriptions/plans - public, list available plans
router.get('/plans', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM subscription_plans WHERE is_active = true ORDER BY price ASC'
    );
    res.json(result.rows);
  } catch (err: any) {
    logger.error('Plans list error:', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// POST /api/subscriptions/checkout - create Stripe checkout session (requires auth)
router.post('/checkout', authenticate, async (req: AuthRequest, res: Response) => {
  if (!stripe) {
    return res.status(503).json({
      error: 'Payments not configured. STRIPE_SECRET_KEY is missing on the server.',
    });
  }

  try {
    const { planId, successUrl, cancelUrl } = req.body;

    const planResult = await db.query('SELECT * FROM subscription_plans WHERE id = $1', [planId]);
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    const plan = planResult.rows[0];

    if (!plan.stripe_price_id) {
      return res.status(400).json({ error: 'Plan is not linked to a Stripe price yet' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: req.company?.email,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: successUrl || `${process.env.FRONTEND_URL}/dashboard?checkout=success`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/tarifs?checkout=cancelled`,
      metadata: { companyId: req.user!.companyId, planId: String(planId) },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err: any) {
    logger.error('Checkout session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/subscriptions/me - current company's subscription (requires auth)
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `SELECT s.*, p.name as plan_name, p.price, p.features
       FROM subscriptions s
       JOIN subscription_plans p ON s.plan_id = p.id
       WHERE s.company_id = $1`,
      [req.user!.companyId]
    );

    if (result.rows.length === 0) {
      return res.json({ subscription: null, status: 'trial' });
    }

    res.json({ subscription: result.rows[0] });
  } catch (err: any) {
    logger.error('Subscription fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// POST /api/subscriptions/cancel - cancel at period end (requires auth)
router.post('/cancel', authenticate, async (req: AuthRequest, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payments not configured' });
  }

  try {
    const subResult = await db.query('SELECT * FROM subscriptions WHERE company_id = $1', [
      req.user!.companyId,
    ]);

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const sub = subResult.rows[0];
    await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });

    await db.query(
      'UPDATE subscriptions SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1',
      [sub.id]
    );

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Subscription cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// POST /api/subscriptions/webhook - Stripe webhook (raw body should be used in production)
router.post('/webhook', async (req: Request, res: Response) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhooks not configured' });
  }

  const sig = req.headers['stripe-signature'] as string;

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const companyId = session.metadata?.companyId;
        const planId = session.metadata?.planId;

        if (companyId && planId) {
          await db.query(
            `INSERT INTO subscriptions (company_id, plan_id, stripe_subscription_id, stripe_customer_id, status)
             VALUES ($1, $2, $3, $4, 'active')
             ON CONFLICT (company_id) DO UPDATE SET
               plan_id = EXCLUDED.plan_id,
               stripe_subscription_id = EXCLUDED.stripe_subscription_id,
               status = 'active',
               updated_at = NOW()`,
            [companyId, planId, session.subscription, session.customer]
          );

          await db.query(
            "UPDATE companies SET subscription_status = 'active' WHERE id = $1",
            [companyId]
          );
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await db.query(
          "UPDATE subscriptions SET status = 'canceled', canceled_at = NOW() WHERE stripe_subscription_id = $1",
          [subscription.id]
        );
        break;
      }
      case 'invoice.payment_failed': {
        // Was previously unhandled: a declined card left subscriptions.status
        // and companies.subscription_status both showing 'active' until Stripe
        // eventually gives up retrying (can be weeks) and fires
        // customer.subscription.deleted - so a company could keep full access
        // for a long time after their card started failing, with no record of
        // the failure anywhere for sales/support to follow up on.
        const invoice = event.data.object as Stripe.Invoice;
        const stripeSubId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        if (stripeSubId) {
          const subResult = await db.query(
            "UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1 RETURNING company_id",
            [stripeSubId]
          );
          if (subResult.rows.length > 0) {
            await db.query(
              "UPDATE companies SET subscription_status = 'past_due' WHERE id = $1",
              [subResult.rows[0].company_id]
            );
            await db.query(
              `INSERT INTO company_alerts (company_id, alert_type, title, message)
               VALUES ($1, 'payment_failed', 'Paiement echoue', 'Le paiement de votre abonnement a echoue. Merci de mettre a jour votre moyen de paiement pour eviter une interruption de service.')`,
              [subResult.rows[0].company_id]
            );
          }
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        // Recovers a subscription that was previously marked past_due (e.g. the
        // customer updated their card after a failed charge).
        const invoice = event.data.object as Stripe.Invoice;
        const stripeSubId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        if (stripeSubId) {
          const subResult = await db.query(
            "UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE stripe_subscription_id = $1 AND status = 'past_due' RETURNING company_id",
            [stripeSubId]
          );
          if (subResult.rows.length > 0) {
            await db.query(
              "UPDATE companies SET subscription_status = 'active' WHERE id = $1",
              [subResult.rows[0].company_id]
            );
          }
        }
        break;
      }
      default:
        logger.info(`Unhandled Stripe event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err: any) {
    logger.error('Stripe webhook error:', err);
    res.status(400).json({ error: `Webhook error: ${err.message}` });
  }
});

export default router;
