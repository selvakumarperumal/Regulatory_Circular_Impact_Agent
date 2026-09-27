# ocr

[Baidu Unlimited-OCR](https://github.com/baidu/Unlimited-OCR), served by vLLM from the official
image `vllm/vllm-openai:unlimited-ocr`. It has no code of its own: the [Dockerfile](Dockerfile)
only sets the server flags. The worker sends it one page image per request and gets back the
page text.

```bash
docker compose up -d ocr          # first start downloads the 6.7 GB model into the hf-cache volume
curl localhost:8001/health        # 200 once the model is loaded (about a minute after the download)
```

**Why these flags (8 GB GPU).** In bf16 the model's weights alone take 6.2 GB. What's left
isn't enough for the vision encoder to process a page, so the model runs out of memory.

- `--quantization fp8` cuts the weights to 3.5 GB. Ampere cards (RTX 30xx) run this as
  weight-only FP8.
- `--skip-mm-profiling` skips sizing memory for the largest image the model accepts
  (32 crops). The worker renders pages at 200 DPI, so an A4 page is about 6 crops.
- `--kv-cache-memory-bytes 700M` fixes the KV cache at about 12k tokens. The rest of the
  GPU stays free for the page images.

On a GPU with 16 GB or more you can remove all three flags.

The other flags: `--trust-remote-code`, the model's `NGramPerReqLogitsProcessor`,
`--no-enable-prefix-caching` and `--mm-processor-cache-gb 0` are the model's own
[vLLM recipe](https://recipes.vllm.ai/baidu/Unlimited-OCR). `--max-num-seqs 1` because the
worker sends one page at a time, and `--max-model-len 8192`, `--gpu-memory-utilization 0.8`
and `--enforce-eager` keep everything inside 8 GB.

The server needs the GPU through the NVIDIA runtime (`runtime: nvidia` in
`docker-compose.yml`).
