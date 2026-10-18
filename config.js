// Supabase connection. The publishable key is safe to expose in a browser:
// row-level security only lets signed-in team members read or change data.
window.PLANNER_CONFIG = {
  supabaseUrl: "https://bnjtoobxqfvosbvwnrie.supabase.co",
  supabaseKey: "sb_publishable_vrJCvon7BQioK2snDPB4Xw_-v7sr0PO",
  projectName: "TPM Project Planner",
  // Bump this with every release (and the ?v= numbers in index.html). See CHANGELOG.md.
  version: "1.1.0",
  released: "2026-10-18"
};
