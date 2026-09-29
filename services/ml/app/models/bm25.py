"""BM25 sparse vectors without a model file: the same scheme fastembed's
Qdrant/bm25 uses, written out so lite mode does not load onnxruntime.

A document term's weight is its BM25 term-frequency component,
tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avg_len)); a query term's is 1.
Qdrant's collection applies IDF at query time (the sparse vector's "idf"
modifier), which completes the score. Terms are lowercased, stripped of
English stopwords, Snowball-stemmed and hashed to a 32-bit index.

Only documents and queries encoded by the same function are comparable, so a
collection built in full mode is not searched by lite mode or the reverse;
each deployment indexes its own documents.
"""

from __future__ import annotations

import re
from collections import Counter
from functools import lru_cache

from ..schemas import SparseVector

K1 = 1.2
B = 0.75
AVG_LEN = 256.0

_TOKEN = re.compile(r"[\w][\w'-]*", re.UNICODE)

# The NLTK English list, which is what fastembed's bm25 removes.
_STOPWORDS = frozenset(
    """a about above after again against ain all am an and any are aren aren't as at be because been
    before being below between both but by can couldn couldn't d did didn didn't do does doesn doesn't
    doing don don't down during each few for from further had hadn hadn't has hasn hasn't have haven
    haven't having he her here hers herself him himself his how i if in into is isn isn't it it's its
    itself just ll m ma me mightn mightn't more most mustn mustn't my myself needn needn't no nor not
    now o of off on once only or other our ours ourselves out over own re s same shan shan't she she's
    should should've shouldn shouldn't so some such t than that that'll the their theirs them
    themselves then there these they this those through to too under until up ve very was wasn wasn't
    we were weren weren't what when where which while who whom why will with won won't wouldn
    wouldn't y you you'd you'll you're you've your yours yourself yourselves""".split()
)


@lru_cache(maxsize=1)
def _stemmer():  # type: ignore[no-untyped-def]
    import snowballstemmer

    return snowballstemmer.stemmer("english")


def _hash(term: str) -> int:
    import mmh3

    return abs(mmh3.hash(term, signed=True))


def terms(text: str) -> list[str]:
    tokens = [token.lower().strip("'-") for token in _TOKEN.findall(text)]
    kept = [token for token in tokens if token and token not in _STOPWORDS and len(token) < 40]
    return _stemmer().stemWords(kept)


def embed_document(text: str) -> SparseVector:
    counts = Counter(terms(text))
    length = sum(counts.values()) or 1
    weights: dict[int, float] = {}
    for term, tf in counts.items():
        value = tf * (K1 + 1) / (tf + K1 * (1 - B + B * length / AVG_LEN))
        index = _hash(term)
        weights[index] = weights.get(index, 0.0) + value
    ordered = sorted(weights)
    return SparseVector(indices=ordered, values=[weights[index] for index in ordered])


def embed_query(text: str) -> SparseVector:
    indices = sorted({_hash(term) for term in terms(text)})
    return SparseVector(indices=indices, values=[1.0] * len(indices))
