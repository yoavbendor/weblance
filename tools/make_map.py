"""Rebuilds data/points.bin, data/points.json and data/labels.json (the map shown on the page).

    pip install pylance umap-learn numpy
    python tools/make_map.py data/

Reads the SigLIP2 vectors and captions of rows 0..24,999 of jrmiller/coco-2017-siglip2-embeddings
from Hugging Face (about 115 MB of vectors), lays them out in 2D with UMAP, and names 24 regions by
the most distinctive words of their captions. Everything else on the page is fetched live.
"""
import collections
import json
import re
import sys
from pathlib import Path

import lance
import numpy as np
import umap

DATASET = "hf://datasets/jrmiller/coco-2017-siglip2-embeddings/lancedb/coco_clip_embeddings.lance"
N = 25000
REGIONS = 24
STOP = set("""a an the of on in with and is are to at for two three his her its by from near some next while
one this that it out up down there their sitting standing has have very other into over front top side small
large big white black red blue green young man men woman women people person group""".split())


def words(s):
    return [w for w in re.findall(r"[a-z]+", s.lower()) if len(w) > 2 and w not in STOP]


def main(out):
    out.mkdir(parents=True, exist_ok=True)
    ds = lance.dataset(DATASET)
    table = ds.to_table(columns=["vector", "caption"], offset=0, limit=N)
    vectors = table["vector"].combine_chunks().values.to_numpy().reshape(N, -1).astype(np.float32)
    captions = table["caption"].to_pylist()

    xy = umap.UMAP(n_neighbors=30, min_dist=0.05, metric="cosine", random_state=7).fit_transform(vectors)
    xy = (xy - xy.min(0)) / (xy.max(0) - xy.min(0))
    q = np.round(xy * 65535).astype("<u2")  # x, y as uint16 per row; point i is dataset row i
    (out / "points.bin").write_bytes(q.tobytes())
    json.dump({"rows": N, "first_row": 0, "format": "uint16 x,y interleaved, row i = dataset row i",
               "source": "UMAP (cosine, n_neighbors=30, min_dist=0.05, random_state=7) of the SigLIP2 vectors "
                         "of rows 0..24999"}, open(out / "points.json", "w"), indent=1)

    # Regions: k-means on the 2D layout, named by the caption words most specific to each region.
    p = q.astype(np.float64) / 65535
    rng = np.random.default_rng(3)
    centers = p[rng.choice(N, REGIONS, replace=False)]
    for _ in range(40):
        label = ((p[:, None, :] - centers[None]) ** 2).sum(-1).argmin(1)
        centers = np.array([p[label == k].mean(0) if (label == k).any() else centers[k] for k in range(REGIONS)])
    everywhere = collections.Counter(w for s in captions for w in set(words(s)))
    regions = []
    for k in range(REGIONS):
        rows = np.where(label == k)[0]
        here = collections.Counter(w for i in rows for w in set(words(captions[i])))
        score = {w: n / len(rows) * np.log(N / everywhere[w]) for w, n in here.items() if n >= 5}
        top = [w for w, _ in sorted(score.items(), key=lambda kv: -kv[1])[:2]]
        regions.append({"x": round(float(centers[k, 0]), 4), "y": round(float(centers[k, 1]), 4),
                        "n": int(len(rows)), "label": " / ".join(top)})
    json.dump(regions, open(out / "labels.json", "w"), indent=0)


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "data"))
