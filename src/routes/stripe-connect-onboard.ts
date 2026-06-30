import type { Request, Response } from 'express';
import { isStripeConfigured, stripe } from '../lib/stripe.js';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';

function badRequest(res: Response, message: string) {
  return res.status(400).json({ ok: false, message });
}

export async function stripeConnectOnboardRoute(req: Request, res: Response) {
  try {
    if (!isStripeConfigured || !stripe) return res.status(500).json({ ok: false, message: 'Stripe não configurado no servidor.' });
    if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase Admin não configurado no servidor.' });

    const providerId = String((req.body as any)?.providerId || '').trim();
    const returnUrl = String((req.body as any)?.returnUrl || '').trim();
    const refreshUrl = String((req.body as any)?.refreshUrl || returnUrl).trim();

    if (!providerId) return badRequest(res, 'providerId é obrigatório.');
    if (!returnUrl) return badRequest(res, 'returnUrl é obrigatório.');

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('id, role, stripe_account_id')
      .eq('id', providerId)
      .maybeSingle();
    if (error) {
      // Se a coluna ainda não existe no Supabase, devolve instrução clara
      if ((error as any)?.code === '42703' && String((error as any)?.message || '').includes('stripe_account_id')) {
        return res.status(500).json({
          ok: false,
          message:
            'Falta a coluna profiles.stripe_account_id no Supabase. Crie com: alter table public.profiles add column if not exists stripe_account_id text;',
        });
      }
      throw error;
    }
    if (!profile) return res.status(404).json({ ok: false, message: 'Prestador não encontrado.' });
    if (String((profile as any).role) !== 'professional') return res.status(403).json({ ok: false, message: 'Apenas prestadores podem ativar recebimentos.' });

    let accountId = String((profile as any).stripe_account_id || '').trim();
    if (!accountId) {
      const acct = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          transfers: { requested: true },
          card_payments: { requested: true },
        },
        business_type: 'individual',
        metadata: { provider_id: providerId },
      });
      accountId = acct.id;
      await supabaseAdmin.from('profiles').update({ stripe_account_id: accountId }).eq('id', providerId);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    return res.json({ ok: true, url: link.url, stripeAccountId: accountId });
  } catch (e: any) {
    console.error('[stripe/connect/onboard]', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Erro ao criar link de onboarding.' });
  }
}


