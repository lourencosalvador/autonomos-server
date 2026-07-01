import OpenAI from 'openai';

// A chave vive SÓ no servidor (nunca no app). Configurada no Railway.
const apiKey = (process.env.OPENAI_API_KEY || '').trim();

export const openaiModel = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
export const isOpenAIConfigured = !!apiKey;
export const openai = apiKey ? new OpenAI({ apiKey }) : null;
