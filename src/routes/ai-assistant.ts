import type { Request, Response } from 'express';
import { isOpenAIConfigured, openai, openaiModel } from '../lib/openai.js';

// Normaliza (minúsculas, sem acentos) para casar nomes de serviço com tolerância.
function norm(s: string) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

const SYSTEM_PROMPT = `És o assistente de IA da Autonomos, um marketplace de serviços em Angola (valores em Kwanzas, Kz).
Falas SEMPRE em português de Angola, de forma calorosa, curta e clara.

## Como a Autonomos funciona (usa isto para responder dúvidas de uso):
- O CLIENTE escolhe um serviço na Home, vê a lista de prestadores, abre o perfil e envia um pedido (local, data, hora, descrição e duração: "menos de 1 dia" ou "mais de 1 dia").
- O PRESTADOR aceita o pedido e define o preço. Depois o cliente paga.
- Pagamento: Multicaixa Express, Cartão (Visa/Mastercard) ou Referência (ATM/banco). O valor fica RETIDO (escrow) na Autonomos e só é libertado ao prestador quando o cliente toca em "Serviço concluído".
- Serviço de vários dias (FlexPay 30/70): o cliente paga 30% no início (vai já para o prestador) e 70% no fim (retido até concluir).
- Urgente: dobra a taxa de solicitação e dá prioridade ao pedido.
- O PRESTADOR recebe na Carteira e pode sacar (o saque chega em 24h–48h). Precisa de ser aprovado para aparecer aos clientes.

## A tua tarefa: classifica cada mensagem numa de duas ações.
1. "search_providers" — o utilizador quer ENCONTRAR/CONTRATAR alguém para um serviço.
   - "service": DEVE ser exatamente um dos nomes da lista de serviços disponíveis (mapeia a intenção: "pintor"→"Pintura", "maquilhadora"→"Make Up", "fotógrafo"→"Fotografia"...). Se nenhum encaixar, usa null.
   - "maxBudget": orçamento em Kz se mencionado ("10 mil"→10000, "5000 kz"→5000), senão null.
   - "urgent": true se pedir urgência/hoje/já, senão false.
   - "answer": uma frase curta e simpática a confirmar a procura (ex: "A procurar pintores até 10.000 Kz perto de si…").
2. "app_help" — dúvida sobre COMO usar o app, pagamentos, escrow, saque, etc.
   - "answer": resposta útil e concisa (2 a 5 frases).
   - "service" null, "maxBudget" null, "urgent" false.

Nunca inventes serviços fora da lista. Se a mensagem for ambígua mas mencionar um serviço, prefere "search_providers".`;

export async function aiAssistantRoute(req: Request, res: Response) {
  try {
    if (!isOpenAIConfigured || !openai) {
      return res.status(500).json({ ok: false, message: 'IA não configurada no servidor (OPENAI_API_KEY).' });
    }

    const message = String((req.body as any)?.message || '').trim().slice(0, 1000);
    const role = String((req.body as any)?.role || 'client');
    const services: string[] = Array.isArray((req.body as any)?.services)
      ? (req.body as any).services.map((s: any) => String(s)).slice(0, 60)
      : [];

    if (!message) return res.status(400).json({ ok: false, message: 'Mensagem vazia.' });

    const servicesBlock = services.length
      ? `\n\n## Serviços disponíveis (usa EXATAMENTE estes nomes em "service"):\n${services.join(', ')}`
      : '';

    const completion = await openai.chat.completions.create({
      model: openaiModel,
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + servicesBlock + `\n\n(Quem fala é um utilizador com o papel: ${role}.)` },
        { role: 'user', content: message },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'assistant_reply',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['search_providers', 'app_help'] },
              service: { type: ['string', 'null'] },
              maxBudget: { type: ['number', 'null'] },
              urgent: { type: 'boolean' },
              answer: { type: 'string' },
            },
            required: ['action', 'service', 'maxBudget', 'urgent', 'answer'],
          },
        },
      },
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { action: 'app_help', answer: 'Desculpa, não consegui perceber. Podes reformular?', service: null, maxBudget: null, urgent: false };
    }

    // Valida o serviço contra a lista real (evita alucinações fora do catálogo).
    let service: string | null = parsed.service ?? null;
    if (service && services.length) {
      const match = services.find((s) => norm(s) === norm(service as string));
      service = match || services.find((s) => norm(s).includes(norm(service as string)) || norm(service as string).includes(norm(s))) || null;
    }

    return res.json({
      ok: true,
      action: parsed.action === 'search_providers' ? 'search_providers' : 'app_help',
      service,
      maxBudget: typeof parsed.maxBudget === 'number' ? parsed.maxBudget : null,
      urgent: parsed.urgent === true,
      answer: String(parsed.answer || '').trim(),
    });
  } catch (e: any) {
    console.error('[ai/assistant]', e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || 'Erro no assistente de IA.' });
  }
}
