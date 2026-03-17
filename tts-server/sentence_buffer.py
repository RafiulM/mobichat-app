import re


class SentenceBuffer:
    """Accumulates LLM tokens, emits complete sentences for TTS."""

    SENTENCE_ENDERS = frozenset(".!?")
    ABBREVIATIONS = frozenset({
        "dr.", "mr.", "mrs.", "ms.", "jr.", "sr.", "prof.",
        "e.g.", "i.e.", "vs.", "etc.", "no.", "st.", "ft.",
        "u.s.", "u.k.", "a.m.", "p.m.",
    })
    MIN_LENGTH = 20

    def __init__(self):
        self._buffer = ""

    def add_token(self, token: str) -> list[str]:
        """Add a token and return any complete sentences."""
        self._buffer += token
        return self._extract_sentences()

    def flush(self) -> str | None:
        """Return remaining buffered text (call when LLM is done)."""
        text = self._buffer.strip()
        self._buffer = ""
        return text if text else None

    def _extract_sentences(self) -> list[str]:
        sentences = []
        while True:
            split = self._find_split_point()
            if split is None:
                break
            sentence = self._buffer[:split].strip()
            self._buffer = self._buffer[split:]
            if sentence:
                sentences.append(sentence)
        return sentences

    def _find_split_point(self) -> int | None:
        """Find the index to split at, or None if no complete sentence."""
        buf = self._buffer
        # Look for sentence-ending punctuation followed by whitespace
        for i, ch in enumerate(buf):
            if ch in self.SENTENCE_ENDERS and i + 1 < len(buf) and buf[i + 1] in " \n\t\r":
                candidate = buf[: i + 1].strip()
                if len(candidate) < self.MIN_LENGTH:
                    continue
                if self._is_abbreviation(buf, i):
                    continue
                # Split after the punctuation + following whitespace
                split_at = i + 1
                while split_at < len(buf) and buf[split_at] in " \n\t\r":
                    split_at += 1
                return split_at
        return None

    def _is_abbreviation(self, buf: str, dot_pos: int) -> bool:
        """Check if the period at dot_pos is part of an abbreviation."""
        if buf[dot_pos] != ".":
            return False
        # Extract the word ending at dot_pos
        start = dot_pos
        while start > 0 and buf[start - 1].isalpha():
            start -= 1
        # Include the dot
        word = buf[start : dot_pos + 1].lower()
        return word in self.ABBREVIATIONS
