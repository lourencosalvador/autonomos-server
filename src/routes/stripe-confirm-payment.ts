import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { isStripeConfigured, stripe } from '../lib/stripe.js';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';

function badRequest(res: Response, message: string) {
  return res.status(400).json({ ok: false, message });
}

function metaInt(pi: Stripe.PaymentIntent, key: string): number | null {
  const v = (pi.metadata as any)?.[key];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function stripeConfirmPaymentRoute(req: Request, res: Response) {
  try {
    if (!isStripeConfigured || !stripe) return res.status(500).json({ ok: false, message: 'Stripe não configurado no servidor.' });
    if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase Admin não configurado no servidor.' });

    const paymentIntentId = String((req.body as any)?.paymentIntentId || '').trim();
    const requestId = String((req.body as any)?.requestId || '').trim();
    if (!paymentIntentId) return badRequest(res, 'paymentIntentId é obrigatório.');
    if (!requestId) return badRequest(res, 'requestId é obrigatório.');

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const metaReqId = String((pi.metadata as any)?.request_id || '').trim();
    if (metaReqId && metaReqId !== requestId) {
      return res.status(403).json({ ok: false, message: 'PaymentIntent não pertence a este pedido.' });
    }

    const status = pi.status;
    const succeeded = status === 'succeeded';
    const paidAt = succeeded ? new Date().toISOString() : null;

    // Upsert payment row — pagamento bem-sucedido entra RETIDO (escrow held)
    await supabaseAdmin.from('payments').upsert(
      {
        request_id: requestId,
        client_id: String((pi.metadata as any)?.client_id || '') || null,
        provider_id: String((pi.metadata as any)?.provider_id || '') || null,
        amount: pi.amount,
        currency: pi.currency,
        status,
        stripe_payment_intent_id: pi.id,
        paid_at: paidAt,
        is_urgent: String((pi.metadata as any)?.is_urgent || '') === 'true',
        escrow_status: 'held',
        agreed_amount: metaInt(pi, 'agreed_amount'),
        request_fee: metaInt(pi, 'request_fee'),
        service_fee: metaInt(pi, 'service_fee'),
        urgent_bonus: metaInt(pi, 'urgent_bonus'),
        provider_net: metaInt(pi, 'provider_net'),
        platform_net: metaInt(pi, 'platform_net'),
      } as any,
      { onConflict: 'stripe_payment_intent_id' }
    );

    // Pedido: pago e RETIDO. O status continua 'accepted' até o cliente liberar (concluir).
    const patch: any = {
      payment_status: status,
      paid_at: paidAt,
      stripe_payment_intent_id: pi.id,
    };
    if (succeeded) patch.escrow_status = 'held';

    const { error } = await supabaseAdmin.from('requests').update(patch).eq('id', requestId);
    if (error) {
      // fallback (não quebra)
      await supabaseAdmin
        .from('requests')
        .update({ payment_status: status, paid_at: paidAt, stripe_payment_intent_id: pi.id } as any)
        .eq('id', requestId);
    }

    return res.json({ ok: true, status, escrowStatus: succeeded ? 'held' : 'none', livemode: (pi as Stripe.PaymentIntent).livemode });
  } catch (e: any) {
    console.error('[stripe/confirm]', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Erro ao confirmar pagamento.' });
  }
}
