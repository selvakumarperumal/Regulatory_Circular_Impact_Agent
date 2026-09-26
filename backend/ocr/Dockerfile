# Baidu Unlimited-OCR (https://github.com/baidu/Unlimited-OCR) served by vLLM with an
# OpenAI-compatible API on :8000. The official image, with flags for an 8 GB GPU.
#
# The model (6.7 GB) is downloaded from Hugging Face on first start; mount a volume on
# /root/.cache/huggingface to keep it (docker-compose.yml does).
FROM vllm/vllm-openai:unlimited-ocr

# The image's entrypoint is `vllm serve`; these are its arguments.
#  - the first four are the model's recipe: https://recipes.vllm.ai/baidu/Unlimited-OCR
#  - fp8: weights take 3.5 GB instead of 6.2 GB (Ampere GPUs use Marlin weight-only FP8)
#  - skip-mm-profiling: vLLM would otherwise size memory for a 32-crop 2560x5120 image,
#    which runs out of memory; the worker sends 200 DPI pages (~6 crops)
#  - a fixed 700 MB KV cache (~12k tokens) leaves the rest free for the page images
#  - one request at a time: the worker sends pages one by one anyway
CMD ["baidu/Unlimited-OCR", \
     "--trust-remote-code", \
     "--logits_processors", "vllm.model_executor.models.unlimited_ocr:NGramPerReqLogitsProcessor", \
     "--no-enable-prefix-caching", \
     "--mm-processor-cache-gb", "0", \
     "--quantization", "fp8", \
     "--skip-mm-profiling", \
     "--kv-cache-memory-bytes", "700M", \
     "--gpu-memory-utilization", "0.8", \
     "--max-model-len", "8192", \
     "--max-num-seqs", "1", \
     "--enforce-eager"]
