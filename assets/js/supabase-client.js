import {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  isSupabaseConfigured
} from "./supabase-config.js";

const SUPABASE_MODULE_URLS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  "https://esm.sh/@supabase/supabase-js@2"
];

export { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isSupabaseConfigured };

export async function loadSupabaseModule() {
  let lastError;
  for (const url of SUPABASE_MODULE_URLS) {
    try {
      return await import(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

let clientPromise;
export function createSupabaseClient() {
  if (!clientPromise) {
    clientPromise = loadSupabaseModule()
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY))
      .catch(error => {
        clientPromise = undefined;
        throw error;
      });
  }
  return clientPromise;
}
