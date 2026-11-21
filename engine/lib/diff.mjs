// Word-level diff of two answers. No imports: this file is also pasted into the report page.

const MAX_DIFF_CELLS = 400_000

const tokensOf = (text) => String(text ?? '').match(/\n|[^\s]+/g) ?? []

/**
 * -> [{ op: 'same' | 'del' | 'add', text }] in reading order, with neighbours of the same op joined,
 * or null when the texts are too long to compare word by word.
 */
export function wordDiff(before, after) {
  const a = tokensOf(before)
  const b = tokensOf(after)
  if (a.length * b.length > MAX_DIFF_CELLS) return null
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const parts = []
  const push = (op, token) => {
    const last = parts[parts.length - 1]
    if (last && last.op === op) last.text += (token === '\n' || last.text.endsWith('\n') ? '' : ' ') + token
    else parts.push({ op, text: token })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++])
    else push('add', b[j++])
  }
  while (i < a.length) push('del', a[i++])
  while (j < b.length) push('add', b[j++])
  return parts
}
