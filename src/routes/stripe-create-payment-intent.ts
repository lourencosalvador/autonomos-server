import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { isStripeConfigured, stripe, stripeMode } from '../lib/stripe.js';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';
import { computeFees, computeInstallments } from '../lib/pricing.js';

function badRequest(res: Response, message: string) {
  return res.status(400).json({ ok: false, message });
}

export async function stripeCreatePaymentIntentRoute(req: Request, res: Response) {
  try {
    if (!isStripeConfigured || !stripe) return res.status(500).json({ ok: false, message: 'Stripe não configurado no servidor.' });
    if (!isSupabaseAdminConfigured || !supabaseAdmin) return res.status(500).json({ ok: false, message: 'Supabase Admin não configurado no servidor.' });

    const requestId = String((req.body as any)?.requestId || '').trim();
    const clientId = String((req.body as any)?.clientId || '').trim(); // opcional (ajuda a validar)
    const isUrgent = (req.body as any)?.isUrgent === true; // urgência marcada pelo cliente no checkout
    const requestedInstallment = Number((req.body as any)?.installment ?? 0); // 1 ou 2 (vários dias)

    if (!requestId) return badRequest(res, 'requestId é obrigatório.');

    const { data: requestRow, error: reqErr } = await supabaseAdmin
      .from('requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();
    if (reqErr) throw reqErr;
    if (!requestRow) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });

    // Regras de negócio mínimas
    if (clientId && String((requestRow as any).client_id) !== clientId) {
      return res.status(403).json({ ok: false, message: 'Este pedido não pertence a este cliente.' });
    }
    if (String((requestRow as any).status) !== 'accepted') {
      return badRequest(res, 'Pagamento só é permitido quando o pedido estiver ACEITE.');
    }

    // Valor ACORDADO definido pelo prestador
    const agreed = Number((requestRow as any).price_amount ?? 0);
    if (!Number.isFinite(agreed) || agreed <= 0) {
      return badRequest(res, 'O prestador ainda não definiu o preço.');
    }

    let currency = String((requestRow as any).currency || 'usd').trim().toLowerCase();
    if (!currency) currency = 'usd';
    // Stripe: AOA (Kwanza) pode não ter métodos ativos. Fallback para USD para não travar o teste.
    const originalCurrency = currency;
    if (currency === 'aoa' || currency === 'kz' || currency === 'kwanza') currency = 'usd';

    // Taxas: o CLIENTE paga o total (acordado + taxa de solicitação). Urgente dobra a taxa.
    const fees = computeFees(agreed, isUrgent);

    // Serviço de vários dias (30/70): o cartão também paga por parcela.
    const isMultiDay = (requestRow as any).is_multi_day === true;
    const installmentsPaid = Number((requestRow as any).installments_paid ?? 0);
    const plan = computeInstallments(fees, isMultiDay);
    let installment = 1;
    let amount = fees.clientTotal;
    if (isMultiDay) {
      if (installmentsPaid >= plan.installmentsTotal) {
        return badRequest(res, 'Este serviço já foi totalmente pago.');
      }
      installment = requestedInstallment >= 1 ? requestedInstallment : installmentsPaid + 1;
      amount = installment >= 2 ? plan.finalClientAmount : plan.firstClientAmount;
    }

    const feeMetadata = {
      agreed_amount: String(fees.agreed),
      client_total: String(fees.clientTotal),
      request_fee: String(fees.requestFee),
      service_fee: String(fees.serviceFee),
      urgent_bonus: String(fees.urgentBonus),
      provider_net: String(fees.providerNet),
      platform_net: String(fees.platformNet),
      is_urgent: String(isUrgent),
    };

    // Reutiliza um PaymentIntent existente quando seguro (mesmo valor/moeda e ainda aberto).
    const existingIntentId = String((requestRow as any).stripe_payment_intent_id || '').trim();
    if (existingIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(existingIntentId);
        const shouldReuse =
          pi.status !== 'succeeded' &&
          pi.status !== 'canceled' &&
          pi.amount === amount &&
          pi.currency === currency;

        if (shouldReuse) {
          return res.json({
            ok: true,
            paymentIntentClientSecret: pi.client_secret,
            paymentIntentId: pi.id,
            stripeMode,
            livemode: pi.livemode,
            fees,
          });
        }
      } catch (e: any) {
        const msg = String(e?.message || '');
        const code = String(e?.code || '');
        if (code === 'resource_missing' || msg.includes('No such payment_intent')) {
          // segue fluxo para criar um novo PI abaixo
        } else {
          throw e;
        }
      }
    }

    const providerId = String((requestRow as any).provider_id);

    // ESCROW: o dinheiro é capturado para a conta da PLATAFORMA e fica retido no nosso ledger.
    // O repasse ao prestador acontece no saque (FlexPay), depois do cliente liberar o serviço.
    // Por isso NÃO usamos destination charge aqui.
    const pi = await stripe.paymentIntents.create({
      amount,
      currency,
      payment_method_types: ['card'],
      metadata: {
        request_id: requestId,
        client_id: String((requestRow as any).client_id),
        provider_id: providerId,
        original_currency: originalCurrency,
        ...feeMetadata,
      },
    });

    // Persiste o PI + snapshot das taxas no pedido (escrow ainda não retido até pagar).
    // Resiliente: se as colunas novas (migração) ainda não existirem, grava só o essencial.
    const reqFull = await supabaseAdmin
      .from('requests')
      .update({
        stripe_payment_intent_id: pi.id,
        payment_status: pi.status,
        is_urgent: isUrgent,
        agreed_amount: fees.agreed,
        client_total: fees.clientTotal,
        request_fee: fees.requestFee,
        service_fee: fees.serviceFee,
        urgent_bonus: fees.urgentBonus,
        provider_net: fees.providerNet,
        platform_net: fees.platformNet,
      } as any)
      .eq('id', requestId);
    if (reqFull.error) {
      await supabaseAdmin
        .from('requests')
        .update({ stripe_payment_intent_id: pi.id, payment_status: pi.status } as any)
        .eq('id', requestId);
    }

    const payFull = await supabaseAdmin.from('payments').upsert(
      {
        request_id: requestId,
        client_id: String((requestRow as any).client_id),
        provider_id: providerId,
        amount,
        currency,
        status: pi.status,
        stripe_payment_intent_id: pi.id,
        is_urgent: isUrgent,
        escrow_status: 'held',
        agreed_amount: fees.agreed,
        request_fee: fees.requestFee,
        service_fee: fees.serviceFee,
        urgent_bonus: fees.urgentBonus,
        provider_net: fees.providerNet,
        platform_net: fees.platformNet,
      } as any,
      { onConflict: 'stripe_payment_intent_id' }
    );
    if (payFull.error) {
      await supabaseAdmin.from('payments').upsert(
        {
          request_id: requestId,
          client_id: String((requestRow as any).client_id),
          provider_id: providerId,
          amount,
          currency,
          status: pi.status,
          stripe_payment_intent_id: pi.id,
        } as any,
        { onConflict: 'stripe_payment_intent_id' }
      );
    }

    return res.json({
      ok: true,
      paymentIntentClientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      stripeMode,
      livemode: pi.livemode,
      fees,
    });
  } catch (e: any) {
    console.error('[stripe/payment-intent]', e);
    if (e?.message === 'Invalid API key') {
      return res.status(500).json({
        ok: false,
        message: 'SUPABASE_SERVICE_ROLE_KEY inválida no servidor. Verifique a service role key no Supabase Dashboard.',
      });
    }
    if (String(e?.message || '').includes('No valid payment method types')) {
      return res.status(400).json({
        ok: false,
        message:
          'Sem métodos de pagamento válidos para esta moeda na Stripe. Para testes, use USD (ou ative métodos compatíveis no Dashboard).',
      });
    }
    return res.status(500).json({ ok: false, message: e?.message || 'Erro ao criar PaymentIntent.' });
  }
}
