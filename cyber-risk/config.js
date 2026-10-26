// Deployment settings. Both values are public by design: the anon key only
// allows what the database's row-level security policies permit.
//
// Leave SUPABASE_URL empty to run in demo mode: data stays in this browser and
// AI uses the API key entered in Settings. See docs/deploy.md.
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

// Signed-in users are signed out after this many minutes without activity.
export const IDLE_TIMEOUT_MINUTES = 30;
