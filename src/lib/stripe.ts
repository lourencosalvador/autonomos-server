import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY || '';

export const isStripeConfigured = !!key;

export const stripeMode: 'test' | 'live' | 'unknown' =
  key.startsWith('sk_test_') ? 'test' : key.startsWith('sk_live_') ? 'live' : 'unknown';

// Importante: não instanciar Stripe sem key, senão o servidor cai no startup.
export const stripe = isStripeConfigured
  ? new Stripe(key, {
      apiVersion: ((process.env.STRIPE_API_VERSION || '2025-01-27.acacia') as any),
    })
  : null;


