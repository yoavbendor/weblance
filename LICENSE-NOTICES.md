# Third-party notices

The WebAssembly module in `lib/` (`weblance.wasm`, with its loader `weblance.js`) is built from:

| Component | What it is in the bundle | License | Copyright / source | Full text |
|---|---|---|---|---|
| nanolance | Lance reader (C++), and `weblance_glue.cpp` (the worker API) | Apache-2.0 | Copyright 2026 Yoav Bendor | [licenses/nanolance-APACHE-2.0.txt](licenses/nanolance-APACHE-2.0.txt), [licenses/nanolance-NOTICE.txt](licenses/nanolance-NOTICE.txt) |
| Apache Arrow nanoarrow | Arrow C data and IPC reading (`nanoarrow`, `nanoarrow_ipc`) | Apache-2.0 | Copyright The Apache Software Foundation; https://github.com/apache/arrow-nanoarrow | [licenses/nanoarrow-LICENSE.txt](licenses/nanoarrow-LICENSE.txt), [licenses/nanoarrow-NOTICE.txt](licenses/nanoarrow-NOTICE.txt) |
| flatcc (runtime) | FlatBuffers-style runtime used by nanoarrow's IPC reader | Apache-2.0 | https://github.com/dvidelabs/flatcc | in [licenses/nanoarrow-LICENSE.txt](licenses/nanoarrow-LICENSE.txt) (nanoarrow's third-party section) |
| Zstandard (zstd) | Column decompression | BSD-3-Clause | Copyright (c) Meta Platforms, Inc. and affiliates; https://github.com/facebook/zstd | [licenses/zstd-LICENSE.txt](licenses/zstd-LICENSE.txt) |
| Emscripten runtime | JavaScript loader and runtime support emitted by the Emscripten compiler | MIT or University of Illinois/NCSA | https://emscripten.org | [licenses/emscripten-LICENSE.txt](licenses/emscripten-LICENSE.txt) |
| musl libc (via Emscripten) | C standard library compiled into the module | MIT | https://musl.libc.org | [licenses/musl-COPYRIGHT.txt](licenses/musl-COPYRIGHT.txt) |
| LLVM libc++ / libc++abi (via Emscripten) | C++ standard library compiled into the module | Apache-2.0 WITH LLVM-exception | https://libcxx.llvm.org | [licenses/libcxx-LICENSE.txt](licenses/libcxx-LICENSE.txt), [licenses/libcxxabi-LICENSE.txt](licenses/libcxxabi-LICENSE.txt) |

The Lance file format definitions that nanolance's protobuf message types are derived from are Apache-2.0,
Copyright The Lance Authors (https://github.com/lance-format/lance). See the nanolance NOTICE above.

The map data (`data/points.bin`, `data/labels.json`) is derived from the dataset described in the README. It is
not third-party software; the dataset's own license (MIT) and the COCO image terms apply to the images.

Not included in the bundle: libprotobuf, liblz4 (nanolance decodes LZ4 with its own code), libcurl and OpenSSL (nanolance's S3 reader is off in this build).
