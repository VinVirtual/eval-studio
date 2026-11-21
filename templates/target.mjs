// A stand-in target so a new project runs at once. Replace it with a call to your own system,
// or change "target" in evals.config.json to an http, command or openai target (see references/targets.md).
//
// A target function gets the question and returns a string, or an object:
//   { answer, sources: [{ id, text }], toolCalls: [{ name, arguments }], usage: { inputTokens, outputTokens, cost } }

const POLICY = { id: 'returns-policy', text: 'Items can be returned within 30 days of delivery.' }

export async function answer(input) {
  if (/return/i.test(input)) return { answer: `${POLICY.text}`, sources: [POLICY] }
  return { answer: "I can't answer that from the documents I have.", sources: [] }
}
