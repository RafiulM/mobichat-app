/**
 * SentenceBuffer — TypeScript port of the Python SentenceBuffer.
 *
 * Accumulates LLM tokens and emits complete sentences for TTS.
 * Ported from: backend/services/sentence_buffer.py
 */

const SENTENCE_ENDERS = new Set(['.', '!', '?', '\u3002', '\uFF01', '\uFF1F'])

const ABBREVIATIONS = new Set([
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'jr.',
  'sr.',
  'prof.',
  'e.g.',
  'i.e.',
  'vs.',
  'etc.',
  'no.',
  'st.',
  'ft.',
  'u.s.',
  'u.k.',
  'a.m.',
  'p.m.',
])

const MIN_LENGTH = 20

const WHITESPACE = new Set([' ', '\n', '\t', '\r'])

export class SentenceBuffer {
  private buffer = ''

  /**
   * Add a token and return any complete sentences.
   */
  addToken(token: string): string[] {
    this.buffer += token
    return this.extractSentences()
  }

  /**
   * Return remaining buffered text (call when LLM stream is done).
   * Returns null if the buffer is empty.
   */
  flush(): string | null {
    const text = this.buffer.trim()
    this.buffer = ''
    return text || null
  }

  private extractSentences(): string[] {
    const sentences: string[] = []
    while (true) {
      const split = this.findSplitPoint()
      if (split === null) {
        break
      }
      const sentence = this.buffer.slice(0, split).trim()
      this.buffer = this.buffer.slice(split)
      if (sentence) {
        sentences.push(sentence)
      }
    }
    return sentences
  }

  /**
   * Find the index to split at, or null if no complete sentence.
   */
  private findSplitPoint(): number | null {
    const buf = this.buffer

    // Look for sentence-ending punctuation followed by whitespace
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i]
      if (
        SENTENCE_ENDERS.has(ch) &&
        i + 1 < buf.length &&
        WHITESPACE.has(buf[i + 1])
      ) {
        const candidate = buf.slice(0, i + 1).trim()
        if (candidate.length < MIN_LENGTH) {
          continue
        }
        if (this.isAbbreviation(buf, i)) {
          continue
        }
        // Split after the punctuation + following whitespace
        let splitAt = i + 1
        while (splitAt < buf.length && WHITESPACE.has(buf[splitAt])) {
          splitAt++
        }
        return splitAt
      }
    }
    return null
  }

  /**
   * Check if the period at dotPos is part of an abbreviation.
   */
  private isAbbreviation(buf: string, dotPos: number): boolean {
    if (buf[dotPos] !== '.') {
      return false
    }
    // Extract the word ending at dotPos
    let start = dotPos
    while (start > 0 && /[a-zA-Z]/.test(buf[start - 1])) {
      start--
    }
    // Include the dot
    const word = buf.slice(start, dotPos + 1).toLowerCase()
    return ABBREVIATIONS.has(word)
  }
}
