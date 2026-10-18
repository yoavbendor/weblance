# weblance

A static web page that reads a Lance dataset on Hugging Face live from the browser. There is no server:
the page is HTML, CSS, JavaScript, a WebAssembly module and a 100 KB map file.

The module is nanolance (a C++ Lance reader, Apache-2.0) compiled to
WebAssembly. Each of six Web Workers opens the dataset with HTTP Range requests, so only the bytes of the rows you
click are fetched; the dataset's 48 GB data file is never downloaded.

Dataset: [jrmiller/coco-2017-siglip2-embeddings](https://huggingface.co/datasets/jrmiller/coco-2017-siglip2-embeddings)
(MIT), 287,360 COCO 2017 images with captions and SigLIP2 vectors. The map is a UMAP of the vectors of rows 0-24,999.

`explore.html` opens any public Hugging Face Lance image dataset: paste its URL (or pick MNIST, CIFAR-10, Oxford
Pets, Food-101 or COCO). The page finds the Lance table, picks the image, embedding and label columns, reads up to
5,000 rows' vectors (ten windows of 500 rows, about 10 MB and 160-190 requests on MNIST and Food-101), lays them out
with PCA in a worker, colors them by class, and fetches the 12 images nearest a click. Nothing is precomputed.

## Files

- `index.html`, `style.css`, `app.js`: the page (map, gallery, live counters, design tokens for light and dark).
- `worker.js`: one worker of the pool. Loads `lib/weblance.js`, opens the dataset once, reads one row at a time.
- `explore.html`, `explore.js`, `explore-worker.js`: the explore page and its worker (sampling, PCA, k-means).
- `lib/weblance.js`, `lib/weblance.wasm`: the module (1,027,128 bytes; 433,623 bytes with `gzip -9`).
- `data/points.bin`: 25,000 map points, two little-endian `uint16` values each (x, y), row i = dataset row i.
- `data/labels.json`: the 24 region names and their centers (0..1), from the captions.
- `data/points.json`: a description of the map file.
- `LICENSE-NOTICES.md`, `licenses/`: the third-party licenses of what the module contains.

## Run it

Any static file server works, from this directory:

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

On GitHub Pages the page works as it is, with no build step.

The page makes no requests except to `huggingface.co` (for the dataset) and to its own files.

### Query overrides

- `?dataset=<URL of a .lance directory>`: a different dataset (the default is the Hugging Face dataset above).
- `?points=<URL>` and `?labels=<URL>`: a different map. Points and labels must match the dataset's rows.
- `?size=<bytes>`: the size of the dataset's data file, for the "share of the file" counter. It is set by default for
  the Hugging Face dataset only.

The dataset URL must allow cross-origin `Range` requests (Hugging Face does; the test server does).

## How lib/ was built

`lib/` comes from `wasm/build_weblance.sh` in the nanolance repository (a separate repository, not included here),
which compiles `wasm/weblance_glue.cpp` against nanolance's single-threaded Emscripten build:

```sh
source /path/to/emsdk/emsdk_env.sh
/path/to/nanolance/wasm/build_weblance.sh /path/to/weblance/lib
```

The module links nanolance, nanoarrow (with its IPC reader), flatcc and zstd. The read block size is the default
16 KiB. The license texts are in `licenses/` and listed in `LICENSE-NOTICES.md`.

## How the map was made

`data/points.bin` and `data/labels.json` come from `tools/make_map.py`: it reads the SigLIP2 vectors
and captions of rows 0-24,999 from the dataset, lays them out with UMAP, and names 24 regions from
their captions (`pip install pylance umap-learn numpy; python tools/make_map.py data/`).

## License

The page's code is Apache-2.0 (`LICENSE`). The WebAssembly module's components and their licenses
are listed in `LICENSE-NOTICES.md`, with the full texts in `licenses/`.

## Credits

- Dataset: jrmiller/coco-2017-siglip2-embeddings (MIT).
- Images: COCO 2017 (Flickr images under their own licenses). Terms: https://cocodataset.org/#termsofuse
- Format: [Lance](https://lancedb.github.io/lance/).
- Reader: nanolance, Apache-2.0, Copyright 2026 Yoav Bendor.
