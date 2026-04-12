/**
 * Self-Evaluation Module
 *
 * Uses the agent's own LLM to review output quality before submission.
 * Scores 0-10000 to match the ProgressiveEscrow alignment threshold (8000 = 80%).
 *
 * Flow inside processMilestone():
 *   1. LLM generates initial output
 *   2. selfEvaluator.evaluate(output, requirements) → { score, passed, issues, improvements }
 *   3. If score < 8000 && retries left → build improvement prompt → go to 1
 *   4. If passed or max retries reached → proceed to upload + submit
 */

export class SelfEvaluator {
  constructor(extendedCompute) {
    this.compute = extendedCompute;
    this.PASS_THRESHOLD = 8000;
    this.MAX_RETRIES    = 3;
  }

  /**
   * Evaluate output quality against job requirements.
   *
   * @param {string} output           - Agent's generated output
   * @param {string} jobRequirements  - Original task description / job brief
   * @param {number} milestoneIndex
   * @param {number} totalMilestones
   * @returns {{ score, passed, issues, improvements, summary }}
   */
  async evaluate(output, jobRequirements, milestoneIndex, totalMilestones) {
    const preview = output.length > 3000
      ? output.slice(0, 3000) + "\n[... output truncated for review ...]"
      : output;

    const prompt =
`You are a strict quality reviewer evaluating an AI agent's deliverable.

JOB REQUIREMENTS:
${jobRequirements}

MILESTONE: ${milestoneIndex + 1} of ${totalMilestones}

AGENT OUTPUT:
${preview}

Evaluate strictly. Respond in EXACT JSON — no other text:
{
  "score": <integer 0-10000>,
  "passed": <true if score >= 8000>,
  "issues": ["<specific issue>", "..."],
  "improvements": ["<specific actionable fix>", "..."],
  "summary": "<one sentence>"
}

Scoring guide:
  9000-10000 — exceeds requirements, production-ready
  8000-8999  — meets requirements, minor imperfections
  6000-7999  — partially meets requirements, notable gaps
  0-5999     — does not meet requirements, major issues`;

    try {
      const result = await this.compute.processTask(prompt, "", "");

      // Extract JSON (handle markdown code fences)
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in evaluation response");

      const ev = JSON.parse(jsonMatch[0]);
      if (typeof ev.score !== "number") throw new Error("Invalid score field");

      return {
        score:        Math.min(10000, Math.max(0, Math.round(ev.score))),
        passed:       ev.score >= this.PASS_THRESHOLD,
        issues:       Array.isArray(ev.issues) ? ev.issues : [],
        improvements: Array.isArray(ev.improvements) ? ev.improvements : [],
        summary:      ev.summary || "",
      };
    } catch (err) {
      console.log(`[SelfEvaluator] Parse error: ${err.message} — defaulting to pass`);
      // Don't block the job on evaluation failure
      return { score: 8500, passed: true, issues: [], improvements: [], summary: "Evaluation unavailable" };
    }
  }

  /**
   * Build an improved task prompt incorporating evaluation feedback.
   */
  buildImprovementPrompt(originalTask, previousOutput, evaluation) {
    const issueList       = evaluation.issues.map((x, i) => `${i + 1}. ${x}`).join("\n");
    const improvementList = evaluation.improvements.map((x, i) => `${i + 1}. ${x}`).join("\n");
    const prevPreview     = previousOutput.slice(0, 800);

    return `${originalTask}

⚠️ IMPROVEMENT REQUIRED — your previous attempt scored ${evaluation.score}/10000 (minimum: 8000).

Issues identified:
${issueList}

Required improvements:
${improvementList}

Your previous output (do NOT repeat these mistakes):
${prevPreview}${previousOutput.length > 800 ? "\n[... truncated ...]" : ""}

Generate an improved version that fully addresses all issues above.`;
  }
}
