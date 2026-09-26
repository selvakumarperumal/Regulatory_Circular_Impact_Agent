# worker

The agent. It takes each circular the watcher saved and works out which internal policies it
makes out of date. For each one, it opens a gap ticket for the policy owner with a draft of
the change.

```
new ──OCR──► parsed ──Gemini──► analyzed        (failed: see `error`; POST /circulars/{id}/reprocess)
 └── published before LOOKBACK_DAYS ──► skipped
```

For each circular, newest first:

1. **OCR**: each page is rendered at 200 DPI and sent to Unlimited-OCR (the `ocr` service),
   up to `OCR_MAX_PAGES` pages. The text is saved, and nothing ever OCRs that circular
   again. A circular whose PDF is identical to one already read (same SHA-256) copies its
   text; blank pages are skipped; if a page times out, the retry resumes at that page.
2. **Summary** (every circular, once): Gemini finds who it's addressed to, sums up what it
   changes, and lists every obligation, keeping the numbers and deadlines as written.
3. **Is it for us?** Only once someone has described the company on the console's Company
   page (the `company` table; there's no default). Gemini compares the addressees with that
   description and gives a one-line reason. With no description, `applicable` stays empty
   ("not checked") and the circular stops here. If it doesn't apply, it stops here too.
4. **Closest policies**: the circular and the policies are embedded with
   `GEMINI_EMBEDDING_MODEL_NAME` (once each; the vectors are saved). Long policies are
   embedded in 5,000-character chunks and score their best chunk. The `MATCH_TOP_K` most
   similar policies tagged with the circular's regulator go on to the next step. No Gemini
   call here: it's arithmetic on the saved vectors.
5. **Out of date?** For each of those policies not judged before at its current version,
   Gemini gets the company description, the obligations, the policy text and its controls.
   It says what is missing, how severe it is, and which controls are affected, and drafts
   replacement wording. The verdict is saved in `policy_checks` straight away.
6. **Gap**: if the policy is out of date, a gap is opened for its owner. The due date
   depends on severity: high 7 days, medium 30, low 60.

Policies are checked from the other side too. When a policy is added or its title, text or
regulators edited, the worker embeds it if needed, then runs steps 4–6 against the analysed
circulars of the last `LOOKBACK_DAYS` that apply to the company, asking only about pairs it
hasn't judged. So a library loaded after the circulars came in still gets its gaps.

**Nothing slow or paid for is done twice.** The OCR text, the summary, "does it apply?"
(until the company description changes), the embeddings and every verdict are saved. A
restart or an outage halfway through resumes where it stopped, and a round with nothing new
makes no OCR or Gemini call.

| File | Job |
|---|---|
| `main.py` | The loop |
| `failures.py` | What counts as "wait", "try again" or "give up" |
| `pipeline.py` | The steps above: for one circular, and for new or edited policies |
| `ocr.py` | PDF to text through Unlimited-OCR |
| `llm.py` | Every Gemini call, through LangChain (`ChatGoogleGenerativeAI.with_structured_output`, `GoogleGenerativeAIEmbeddings`). Each prompt comes with the Pydantic model its reply must match |
| `storage.py` | Reads the PDFs from S3 |
| `config.py` | Settings, from the environment or `.env` |

**When something fails.**
- **OCR unreachable** (the model is still loading) **or Gemini rate-limited (429):** the
  worker waits and tries again as long as it takes.
- **A 5xx, a timeout, a dropped connection or a reply not in the asked-for JSON:** the
  circular is retried up to 3 times, then marked `failed` with the error.
- **A wrong API key or model name:** the worker stops at startup.

LangChain first retries Gemini rate limits and server errors itself (`max_retries=3`), and
raises its own error classes. The worker reads the HTTP code from the original Gemini
error underneath (`gemini_status` in `failures.py`).

```bash
cp .env.example .env                # set GEMINI_API_KEY
uv sync
uv run python main.py --once        # one pass through the queue
```
