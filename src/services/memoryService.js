/**
 * Agent Memory Service
 *
 * Persists agent learnings across jobs. Each entry captures:
 * - Client preferences observed during job execution
 * - Job outcome (alignment score)
 * - Key learnings extracted by LLM from the feedback loop
 *
 * Flow:
 *   Job starts → recall(agentId, clientAddress, jobType) → inject into LLM context
 *   Job ends   → save({ clientAddress, jobId, jobType, outcomeScore, chatFeedback }) → upsert to Supabase
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

/** Thin REST wrapper — avoids adding @supabase/supabase-js dep to agent-runtime */
async function sbFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase env vars not set");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer:        "return=representation",
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export class MemoryService {
  constructor(agentId, extendedCompute) {
    this.agentId = Number(agentId);
    this.compute  = extendedCompute;
  }

  /**
   * Recall the top-5 most recent memories for this agent + client combo.
   * Returns a formatted string ready to inject into the LLM context, or null if none.
   */
  async recall(clientAddress, jobType = "general") {
    if (!clientAddress) return null;
    try {
      const rows = await sbFetch(
        `agent_memory?agent_id=eq.${this.agentId}&client_address=eq.${clientAddress.toLowerCase()}&order=updated_at.desc&limit=5&select=*`
      );

      if (!rows || rows.length === 0) return null;

      const memoryText = rows.map(m => {
        const lines = [
          `[${m.job_type || "general"} — score ${m.outcome_score ?? "??"}/10000]`,
          ...(m.key_learnings || []).map(l => `• ${l}`),
        ];
        if (m.preferences && Object.keys(m.preferences).length > 0) {
          const prefStr = Object.entries(m.preferences)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          lines.push(`  Prefs: ${prefStr}`);
        }
        return lines.join("\n");
      }).join("\n\n");

      return `MEMORY — past work with this client (apply these learnings now):\n${memoryText}`;
    } catch (err) {
      console.log(`[MemoryService] Recall failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Save a memory entry after a milestone is approved.
   * Uses LLM to extract structured learnings from the raw chat feedback.
   */
  async save({ clientAddress, jobId, jobType = "general", outcomeScore, chatFeedback, outputSummary }) {
    if (!clientAddress) return;

    let keyLearnings = [];
    let preferences  = {};

    // Use LLM to extract structured learnings from feedback
    if (chatFeedback && chatFeedback.trim().length > 10) {
      try {
        const extraction = await this.compute.processTask(
          `You are extracting actionable learnings from a client's feedback about an AI agent's work.

Client feedback:
${chatFeedback}

Agent output summary:
${(outputSummary || "").slice(0, 400)}

Respond ONLY in this exact JSON format (no extra text):
{
  "keyLearnings": ["<concise actionable learning, max 80 chars>"],
  "preferences": {
    "style": "<style preference if explicitly mentioned, else null>",
    "format": "<output format preference if mentioned, else null>",
    "constraints": "<any hard constraints mentioned, else null>"
  }
}

Rules: max 5 learnings, only what's explicitly stated or clearly implied, omit null preference fields.`,
          "", ""
        );

        const jsonMatch = extraction.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          keyLearnings = (parsed.keyLearnings || []).slice(0, 5);
          preferences  = parsed.preferences  || {};
          // Drop null/empty preference fields
          Object.keys(preferences).forEach(k => {
            if (!preferences[k] || preferences[k] === "null") delete preferences[k];
          });
        }
      } catch (err) {
        console.log(`[MemoryService] Learning extraction failed: ${err.message}`);
      }
    }

    // Check for existing memory entry for this agent + client + job type
    try {
      const existing = await sbFetch(
        `agent_memory?agent_id=eq.${this.agentId}&client_address=eq.${clientAddress.toLowerCase()}&job_type=eq.${encodeURIComponent(jobType)}&limit=1&select=id,key_learnings,preferences`
      );

      if (existing && existing.length > 0) {
        const row = existing[0];
        // Merge learnings — deduplicate, cap at 10
        const merged   = [...new Set([...(row.key_learnings || []), ...keyLearnings])].slice(0, 10);
        const mergedPrefs = { ...(row.preferences || {}), ...preferences };

        await sbFetch(`agent_memory?id=eq.${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            outcome_score: outcomeScore,
            key_learnings: merged,
            preferences:   mergedPrefs,
            raw_feedback:  chatFeedback,
            job_id:        jobId ? Number(jobId) : null,
          }),
        });
        console.log(`[MemoryService] Updated memory for ${clientAddress.slice(0, 10)}… (${merged.length} learnings)`);
      } else {
        await sbFetch("agent_memory", {
          method: "POST",
          body: JSON.stringify({
            agent_id:      this.agentId,
            client_address: clientAddress.toLowerCase(),
            job_id:         jobId ? Number(jobId) : null,
            job_type:       jobType,
            outcome_score:  outcomeScore,
            key_learnings:  keyLearnings,
            preferences,
            raw_feedback:   chatFeedback,
          }),
        });
        console.log(`[MemoryService] Created memory for ${clientAddress.slice(0, 10)}… (${keyLearnings.length} learnings)`);
      }
    } catch (err) {
      console.log(`[MemoryService] Save failed: ${err.message}`);
    }
  }
}
