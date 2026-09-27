FROM vllm/vllm-openai:unlimited-ocr

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
