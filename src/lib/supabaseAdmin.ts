import { createClient } from '@supabase/supabase-js';

// .trim() é importante: ao colar a URL/chave no painel do Render é comum entrar um
// espaço ou quebra de linha no fim, o que faz o fetch do supabase-js falhar com "fetch failed".
const url = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

export const isSupabaseAdminConfigured = !!(url && serviceKey);

// Apenas o host (info pública, já presente no app) — usado pelo /health para diagnóstico.
export const supabaseHost = (() => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return `INVALID_URL(${JSON.stringify(url).slice(0, 40)})`;
  }
})();

// Importante: não criar client sem URL/Service key, senão o servidor cai no startup.
export const supabaseAdmin = isSupabaseAdminConfigured
  ? createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;


