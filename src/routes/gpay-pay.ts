import type { Request, Response } from 'express';
import { computeFees, computeInstallments } from '../lib/pricing.js';
import { gpay, gpayChargeAmount, gpayHeaders, isGpayConfigured, randomTransactionId } from '../lib/gpay.js';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';

function badRequest(res: Response, message: string) {
  return res.status(400).json({ ok: false, message });
}

/**
 * Inicia um pagamento via GPay Angola.
 * - method 'multicaixa' → Multicaixa Express (push ao telemóvel do cliente)
 * - method 'reference'  → Pagamento por Referência (devolve referenceNumber)
 * A confirmação chega ao webhook (POST /api/gpay/webhook), que retém o escrow.
 */
export async function gpayPayRoute(req: Request, res: Response) {
  try {
    if (!isGpayConfigured) return res.status(500).json({ ok: false, message: 'GPay não configurado no servidor.' });
    if (!isSupabaseAdminConfigured || !supabaseAdmin) {
      return res.status(500).json({ ok: false, message: 'Supabase Admin não configurado no servidor.' });
    }

    const requestId = String((req.body as any)?.requestId || '').trim();
    const clientId = String((req.body as any)?.clientId || '').trim();
    const isUrgent = (req.body as any)?.isUrgent === true;
    const method = String((req.body as any)?.method || 'multicaixa').trim(); // 'multicaixa' | 'reference'
    const phone = String((req.body as any)?.phone || '').replace(/[^\d]/g, '');
    const name = String((req.body as any)?.name || 'Cliente').trim();
    const email = String((req.body as any)?.email || '').trim();

    if (!requestId) return badRequest(res, 'requestId é obrigatório.');
    if (method !== 'multicaixa' && method !== 'reference') return badRequest(res, 'Método de pagamento inválido.');
    if (method === 'multicaixa' && phone.length < 9) return badRequest(res, 'Número de telemóvel inválido.');

    const { data: requestRow, error: reqErr } = await supabaseAdmin
      .from('requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();
    if (reqErr) throw reqErr;
    if (!requestRow) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });

    if (clientId && String((requestRow as any).client_id) !== clientId) {
      return res.status(403).json({ ok: false, message: 'Este pedido não pertence a este cliente.' });
    }
    if (String((requestRow as any).status) !== 'accepted') {
      return badRequest(res, 'Pagamento só é permitido quando o pedido estiver ACEITE.');
    }

    const agreed = Number((requestRow as any).price_amount ?? 0);
    if (!Number.isFinite(agreed) || agreed <= 0) {
      return badRequest(res, 'O prestador ainda não definiu o preço.');
    }

    const fees = computeFees(agreed, isUrgent);

    // Serviço de vários dias (FlexPay 30/70): paga em 2 parcelas (30% no início, 70% no fim).
    const isMultiDay = (requestRow as any).is_multi_day === true;
    const installmentsPaid = Number((requestRow as any).installments_paid ?? 0);
    const plan = computeInstallments(fees, isMultiDay);

    let installment = 1; // 1 = pagamento único OU 1ª parcela; 2 = parcela final
    let installmentClientAmount = fees.clientTotal;
    if (isMultiDay) {
      if (installmentsPaid >= plan.installmentsTotal) {
        return badRequest(res, 'Este serviço já foi totalmente pago.');
      }
      installment = installmentsPaid + 1;
      installmentClientAmount = installment === 1 ? plan.firstClientAmount : plan.finalClientAmount;
    }

    // price_amount é minor units (Kz × 100). GPay espera Kwanzas inteiros.
    // Em modo teste (GPAY_TEST_MODE), o montante enviado é forçado para 100 Kz.
    const amount = gpayChargeAmount(installmentClientAmount / 100);

    const transactionId = randomTransactionId();
    const payload = {
      amount,
      redirect_url: gpay.redirectUrl,
      customer: { name, phone, email },
      description: `Autonomos • ${String((requestRow as any).service_name || 'Serviço')}`,
      payment_method: method,
      transaction_type: 'payment',
      transaction_id: transactionId,
    };

    // DEBUG temporário: confirma que a API key sai no header certo.
    const _h = gpayHeaders();
    console.log('[gpay/pay] DEBUG header:', {
      url: `${gpay.baseUrl}/api/pay`,
      keyLoaded: !!gpay.apiKey,
      keyLen: gpay.apiKey.length,
      keyPreview: gpay.apiKey ? `${gpay.apiKey.slice(0, 6)}...${gpay.apiKey.slice(-4)}` : '(vazia)',
      headerNames: Object.keys(_h),
      payloadAmount: payload.amount,
      payloadMethod: payload.payment_method,
    });

    const resp = await fetch(`${gpay.baseUrl}/api/pay`, {
      method: 'POST',
      headers: _h,
      body: JSON.stringify(payload),
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Log do motivo exato devolvido pelo GPay (ver na consola do servidor).
      console.error('[gpay/pay] GPay rejeitou:', resp.status, JSON.stringify(data));
      const authIssue = resp.status === 401 || resp.status === 403;
      return res.status(502).json({
        ok: false,
        message:
          data?.message ||
          (authIssue
            ? 'GPay: não autorizado. Falta a API key/token da conta GPay (GPAY_API_KEY) ou está inválida.'
            : `GPay recusou o pagamento (HTTP ${resp.status}).`),
        status: resp.status,
        details: data,
      });
    }

    // Guarda o transaction_id no pedido (o webhook mapeia por ele) + snapshot de taxas.
    const fullPatch: any = {
      payment_method: method === 'reference' ? 'gpay_reference' : 'gpay_multicaixa',
      gpay_transaction_id: transactionId,
    };
    // Em vários dias, regista qual parcela está pendente (o webhook usa para idempotência).
    if (isMultiDay) fullPatch.gpay_pending_installment = installment;
    // Snapshot de taxas: grava no arranque (pagamento único, ou 1ª parcela do multi-dia).
    if (!isMultiDay || installment === 1) {
      fullPatch.is_urgent = isUrgent;
      fullPatch.agreed_amount = fees.agreed;
      fullPatch.client_total = fees.clientTotal;
      fullPatch.request_fee = fees.requestFee;
      fullPatch.service_fee = fees.serviceFee;
      fullPatch.urgent_bonus = fees.urgentBonus;
      fullPatch.provider_net = fees.providerNet;
      fullPatch.platform_net = fees.platformNet;
    }
    const upd = await supabaseAdmin.from('requests').update(fullPatch).eq('id', requestId);
    if (upd.error) {
      await supabaseAdmin
        .from('requests')
        .update({ gpay_transaction_id: transactionId, is_urgent: isUrgent } as any)
        .eq('id', requestId)
        .then(() => {}, () => {});
    }

    // Pagamento por referência: extrai a referência para mostrar ao utilizador.
    const reference = data?.reference || data?.data?.reference || null;
    const referenceNumber = reference?.referenceNumber || reference?.reference_number || data?.referenceNumber || null;
    const entity = reference?.entity || reference?.entityNumber || data?.entity || null;

    return res.json({ ok: true, method, transactionId, amount, installment, installmentsTotal: plan.installmentsTotal, referenceNumber, entity, reference, raw: data });
  } catch (e: any) {
    console.error('[gpay/pay]', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Erro ao iniciar o pagamento GPay.' });
  }
}
