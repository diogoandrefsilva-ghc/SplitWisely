/* ============================================================
   Configuração da SplitWisely
   ------------------------------------------------------------
   Projeto Supabase PARTILHADO com as outras apps (Bet4Fun, …):
     Supabase Dashboard → Project Settings → API
       • Project URL                    → SUPABASE_URL
       • Project API keys → anon/public → SUPABASE_ANON_KEY

   ⚠️ A anon key é PÚBLICA por design — pode ficar aqui. A
   segurança vem toda das políticas RLS no schema `splitwisely`
   (ver supabase/schema.sql). NUNCA metas aqui a service_role key.
   ============================================================ */

window.APP_CONFIG = {
  SUPABASE_URL: "https://gjweqwfbnkgnibhajldc.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk",
};
