import type { Request, Response } from 'express';
import { isSupabaseAdminConfigured, supabaseAdmin } from '../lib/supabaseAdmin.js';

function badRequest(res: Response, message: string) {
  return res.status(400).json({ ok: false, message });
}

/**
 * Liberação do escrow pelo CLIENTE ("Serviço concluído").
 * Muda o pagamento de RETIDO ("em processamento") para LIBERADO ("realizado"),
 * tornando o líquido do prestador sacável, e marca o pedido como concluído.
 */
export async function escrowReleaseRoute(req: Request, res: Response) {
  try {
    if (!isSupabaseAdminConfigured || !supabaseAdmin) {
      return res.status(500).json({ ok: false, message: 'Supabase Admin não configurado no servidor.' });
    }

    const requestId = String((req.body as any)?.requestId || '').trim();
    const clientId = String((req.body as any)?.clientId || '').trim();
    if (!requestId) return badRequest(res, 'requestId é obrigatório.');

    const { data: requestRow, error: reqErr } = await supabaseAdmin
      .from('requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();
    if (reqErr) throw reqErr;
    if (!requestRow) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });

    // Só o cliente do pedido pode liberar
    if (clientId && String((requestRow as any).client_id) !== clientId) {
      return res.status(403).json({ ok: false, message: 'Apenas o cliente do pedido pode liberar o pagamento.' });
    }

    const paid =
      String((requestRow as any).payment_status || '') === 'succeeded' || !!(requestRow as any).paid_at;
    if (!paid) {
      return badRequest(res, 'Este pedido ainda não foi pago — não há nada para liberar.');
    }

    const alreadyReleased = String((requestRow as any).escrow_status || '') === 'released';

    // Serviço de vários dias: só pode concluir depois da parcela final (70%) ser paga.
    const isMultiDay = (requestRow as any).is_multi_day === true;
    if (isMultiDay && !alreadyReleased && Number((requestRow as any).installments_paid ?? 0) < 2) {
      return badRequest(res, 'Pague a parcela final (70%) antes de concluir o serviço.');
    }

    const releasedAt = (requestRow as any).released_at || new Date().toISOString();
    const providerNet = Number((requestRow as any).provider_net ?? 0);

    // Atualiza o pedido: liberado + concluído. Em vários dias, move o retido (70%) para liberado.
    const releasePatch: any = { escrow_status: 'released', released_at: releasedAt, status: 'completed', completed_at: releasedAt };
    if (isMultiDay) {
      releasePatch.provider_released_amount = providerNet; // tudo liberado
      releasePatch.provider_held_amount = 0;
    }
    const { error: upReqErr } = await supabaseAdmin.from('requests').update(releasePatch).eq('id', requestId);
    if (upReqErr) {
      // fallback sem completed_at (caso a coluna não exista)
      delete releasePatch.completed_at;
      await supabaseAdmin.from('requests').update(releasePatch).eq('id', requestId);
    }

    // Atualiza o pagamento correspondente
    await supabaseAdmin
      .from('payments')
      .update({ escrow_status: 'released', released_at: releasedAt } as any)
      .eq('request_id', requestId);

    return res.json({ ok: true, escrowStatus: 'released', alreadyReleased, releasedAt });
  } catch (e: any) {
    console.error('[escrow/release]', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Erro ao liberar o pagamento.' });
  }
}
