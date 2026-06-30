import crypto from 'crypto';
import type { Request, Response } from 'express';
import { gpay } from '../lib/gpay.js';
import { MULTI_DAY_FIRST_RATE } from '../lib/pricing.js';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';

/**
 * Webhook/notificação do GPay. Quando o pagamento é confirmado (Multicaixa Express
 * ou Referência), marca o pedido como pago e RETIDO (escrow held).
 * Mapeia o pedido pelo transaction_id que guardámos em requests.gpay_transaction_id.
 */
export async function gpayWebhookRoute(req: Request, res: Response) {
  try {
    const raw =
      req.body instanceof Buffer
        ? req.body.toString('utf8')
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body || {});

    // Assinatura opcional (se a conta GPay assinar com um segredo).
    const signature = String(req.headers['x-signature'] || req.headers['x-gpay-signature'] || '').toLowerCase();
    if (gpay.webhookSecret && signature) {
      const expected = crypto.createHmac('sha256', gpay.webhookSecret).update(raw, 'utf8').digest('hex');
      if (expected !== signature) return res.status(401).json({ ok: false, message: 'Assinatura inválida.' });
    }

    const evt: any = (() => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    })();
    const tx: any = evt?.transaction || evt?.data || evt;
    const transactionId = String(tx?.transaction_id || evt?.transaction_id || tx?.transactionId || '').trim();
    const status = String(tx?.status || evt?.status || '').toLowerCase();

    if (!transactionId) return res.json({ ok: true, ignored: true });

    const paid =
      status === 'paid' ||
      status === 'success' ||
      status === 'succeeded' ||
      status === 'accepted' ||
      status === 'completed' ||
      status === 'confirmed';
    if (!paid) return res.json({ ok: true, status });

    if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false });

    // Localiza o pedido pelo transaction_id para decidir o efeito (pagamento único vs. parcela).
    const { data: requestRow, error: findErr } = await supabaseAdmin
      .from('requests')
      .select('*')
      .eq('gpay_transaction_id', transactionId)
      .maybeSingle();
    if (findErr) return res.status(500).json({ ok: false, message: findErr.message });
    if (!requestRow) return res.json({ ok: true, ignored: true }); // tx desconhecido

    const id = (requestRow as any).id;
    const paidAt = (requestRow as any).paid_at || new Date().toISOString();

    // Pagamento único: pago + retido (comportamento original).
    if ((requestRow as any).is_multi_day !== true) {
      const upd = await supabaseAdmin
        .from('requests')
        .update({ payment_status: 'succeeded', paid_at: paidAt, escrow_status: 'held' } as any)
        .eq('id', id);
      if (upd.error) return res.status(500).json({ ok: false, message: upd.error.message });
      return res.json({ ok: true });
    }

    // Serviço de vários dias (30/70). Idempotente via gpay_pending_installment + GREATEST.
    const providerNet = Number((requestRow as any).provider_net ?? 0);
    const firstProviderNet = Math.round(providerNet * MULTI_DAY_FIRST_RATE);
    const pendingInstallment = Number((requestRow as any).gpay_pending_installment ?? 1);
    const installmentsPaid = Math.max(Number((requestRow as any).installments_paid ?? 0), pendingInstallment);

    const patch: any = {
      payment_status: 'succeeded',
      paid_at: paidAt,
      escrow_status: 'held',
      installments_paid: installmentsPaid,
      // 1ª parcela paga → 30% do líquido vai DIRETO ao prestador (sacável já).
      provider_released_amount: firstProviderNet,
    };
    // Parcela final paga → 70% fica RETIDO até "Serviço concluído".
    if (installmentsPaid >= 2) patch.provider_held_amount = providerNet - firstProviderNet;

    const upd = await supabaseAdmin.from('requests').update(patch).eq('id', id);
    if (upd.error) return res.status(500).json({ ok: false, message: upd.error.message });
    return res.json({ ok: true, installmentsPaid });
  } catch (e: any) {
    console.error('[gpay/webhook]', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Erro no webhook GPay.' });
  }
}
