import asyncio
import os
import re
import urllib.request
from contextlib import asynccontextmanager
from typing import Dict, Optional
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

load_dotenv()

_SELF_URL = "https://wryte-zbg5.onrender.com/health"
_PING_INTERVAL = 10  # seconds


async def _keep_alive():
    while True:
        await asyncio.sleep(_PING_INTERVAL)
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, urllib.request.urlopen, _SELF_URL)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_keep_alive())
    yield
    task.cancel()


app = FastAPI(title="Wryte Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Liveness probe for load balancers and platforms (e.g. Render, Docker)."""
    return {"status": "ok", "service": "wryte-backend"}


class AutocompleteRequest(BaseModel):
    text: str
    model: str = "qwen/qwen-2.5-7b-instruct"
    url: Optional[str] = None
    field_type: Optional[str] = None

class AutocompleteResponse(BaseModel):
    completion: str


REWRITE_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free"

# Preset keys must match extension rewrite buttons
STYLE_INSTRUCTIONS: Dict[str, str] = {
    "formal": "Rewrite to sound more formal, precise, and suitable for professional or academic contexts. Preserve the original meaning.",
    "casual": "Rewrite in a warm, conversational, friendly tone as if speaking to a peer. Keep the same meaning.",
    "shorter": "Make the text significantly more concise while preserving all essential meaning. Remove redundancy.",
    "expand": "Expand with helpful detail, examples, or clarification while staying on topic. Do not add unrelated content.",
    "clearer": "Simplify wording and structure so it is easier to understand. Prefer plain language over jargon.",
    "grammar": "Fix grammar, spelling, and punctuation only. Do not change meaning or tone unless required for correctness.",
    "bullets": "Restructure the content as a clear bullet list (use • or -). Merge related points sensibly.",
    "professional": "Rewrite for a concise workplace or business context: direct, respectful, and action-oriented.",
}


class RewriteRequest(BaseModel):
    text: str
    style: str


class RewriteResponse(BaseModel):
    text: str

def build_context_hint(url: Optional[str], field_type: Optional[str]) -> str:
    parts = []
    if url:
        try:
            domain = urlparse(url).netloc or url
            if domain:
                parts.append(f"The user is typing on: {domain}.")
        except Exception:
            pass
    if field_type:
        label = {
            "input": "a single-line input field",
            "textarea": "a multi-line text area",
            "div": "a rich-text editor",
        }.get(field_type, field_type)
        parts.append(f"Field type: {label}.")
    return ("\n" + " ".join(parts)) if parts else ""

def get_llm(api_key: str, model: str, max_tokens: int = 30, temperature: float = 0.2) -> ChatOpenAI:
    return ChatOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        default_headers={
            "HTTP-Referer": "https://wryte-extension.local",
            "X-Title": "Wryte"
        }
    )


def trailing_stub(text: str) -> str:
    """Non-whitespace run at end of text before cursor (partial or full last 'word')."""
    if not text:
        return ""
    m = re.search(r"\S*$", text)
    return m.group(0) if m else ""


def _strip_outer_quotes(s: str) -> str:
    s = (s or "").strip()
    if len(s) >= 2 and s.startswith('"') and s.endswith('"'):
        s = s[1:-1].strip()
    return s


def clamp_to_max_words(fragment: str, max_words: int, *, leading_space: bool) -> str:
    fragment = fragment.strip()
    if not fragment:
        return ""
    words = fragment.split()
    core = " ".join(words[:max_words])
    return (" " + core) if leading_space else core


# Pure morphological tails the model sometimes emits with no character overlap on stub
_COMMON_STEM_SUFFIXES = frozenset({
    "ing", "ed", "ly", "es", "tion", "ation", "ment", "ness", "ful", "less",
    "est", "ers", "ies", "ied", "ify", "ise", "ize", "izing", "ised", "ized",
    "ingly", "edly",
})


def overlap_suffix(stub: str, fragment: str) -> Optional[str]:
    """
    When the model returns a continuation that aligns with the end of stub (e.g. stub
    'writ', fragment 'riting' → 'ing'), return the non-overlapping suffix only.
    Requires a minimum overlap length to avoid spurious matches on very short stubs.
    """
    if len(stub) < 2 or len(fragment) < 2:
        return None
    max_k = min(len(stub), len(fragment))
    min_k = 3 if len(stub) >= 3 else 2
    if max_k < min_k:
        return None
    for k in range(max_k, min_k - 1, -1):
        if stub[-k:].lower() == fragment[:k].lower():
            return fragment[k:]
    return None


def finalize_completion(text_before_cursor: str, raw: str) -> str:
    """
    Merge model output with text before cursor so the client only inserts suffix
    characters (no duplicated prefix of the word being typed).
    """
    s = _strip_outer_quotes(raw)
    if not s:
        return ""

    stub = trailing_stub(text_before_cursor)
    parts = s.split(None, 1)
    first = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    # After whitespace: continue with up to 5 words (phrase-style)
    if not stub:
        return clamp_to_max_words(s, 5, leading_space=False)

    sl, fl = stub.lower(), first.lower()
    if fl.startswith(sl):
        remainder_word = first[len(stub):]
        if remainder_word:
            fragment = remainder_word + (" " + rest if rest else "")
            return clamp_to_max_words(fragment, 5, leading_space=False)
        if rest:
            return clamp_to_max_words(rest, 5, leading_space=True)
        return ""

    merged = overlap_suffix(stub, first)
    if merged is not None:
        fragment = merged + (" " + rest if rest else "")
        return clamp_to_max_words(fragment, 5, leading_space=False)

    # Model gave only an inflection tail (e.g. stub "writ", first "ing") — no gap
    if not rest and first.lower() in _COMMON_STEM_SUFFIXES:
        return clamp_to_max_words(first, 5, leading_space=False)

    # Whole word typed with no space — insert space before following words
    return clamp_to_max_words(s, 5, leading_space=True)


def build_prompt(context_hint: str, ends_after_space: bool) -> ChatPromptTemplate:
    if ends_after_space:
        follow = (
            " The snippet ends right after whitespace. Continue with ONLY 1–5 words "
            "that naturally follow — no explanations, no quotes, no repetition of the input."
        )
    else:
        follow = (
            " The snippet ends with characters of a word but with NO space after the last "
            "character you see. Continue in the same style: first output only what is still "
            "missing from that word (do not repeat letters the user already typed at the end), "
            "then you may add a single space and up to a few more words (at most 5 words in total). "
            "Never begin your reply with whitespace. "
            "No explanations, no quotes, no repetition of the input text."
        )
    system = (
        f"You are an inline text autocomplete engine.{context_hint}"
        " Complete in exactly the same style, tone, and vocabulary the user has been using."
        + follow
    )
    return ChatPromptTemplate.from_messages([
        ("system", system),
        ("user", "{text}")
    ])

@app.post("/autocomplete", response_model=AutocompleteResponse)
async def get_autocomplete(request: AutocompleteRequest):
    print(f"\n--- New Autocomplete Request ---")
    print(f"Model: {request.model}")
    print(f"URL: {request.url}")
    print(f"Text snippet: '{request.text}'")

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY not configured")

    try:
        context_hint = build_context_hint(request.url, request.field_type)
        tb = request.text or ""
        ends_after_space = bool(tb) and tb[-1].isspace()
        llm = get_llm(api_key, request.model, max_tokens=30)
        chain = build_prompt(context_hint, ends_after_space) | llm | StrOutputParser()

        result = await chain.ainvoke({"text": request.text})
        result = finalize_completion(tb, result)

        print(f"Completion: '{result}'")
        print("--------------------------------\n")

        return AutocompleteResponse(completion=result)

    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def normalize_rewrite_output(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("```"):
        lines = s.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    if len(s) >= 2 and s[0] in '"\'' and s[-1] == s[0]:
        s = s[1:-1].strip()
    return s


def build_rewrite_template(instruction: str) -> ChatPromptTemplate:
    system = (
        "You rewrite user-selected passages exactly as instructed. "
        "Output ONLY the rewritten passage: no title, no preamble (e.g. 'Here is' or 'Rewritten:'), "
        "and no surrounding quotation marks unless the original was entirely a quote. "
        "Do not wrap the result in markdown code fences.\n\n"
        f"Instruction: {instruction}"
    )
    return ChatPromptTemplate.from_messages([
        ("system", system),
        ("user", "Text to rewrite:\n\n{text}"),
    ])


@app.post("/rewrite", response_model=RewriteResponse)
async def rewrite_text(request: RewriteRequest):
    if request.style not in STYLE_INSTRUCTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown style: {request.style}. Valid: {', '.join(sorted(STYLE_INSTRUCTIONS.keys()))}",
        )
    body = (request.text or "").strip()
    if len(body) < 1:
        raise HTTPException(status_code=400, detail="Selected text is empty.")
    if len(body) > 16000:
        raise HTTPException(status_code=400, detail="Selected text is too long (max 16000 characters).")

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY not configured")

    print(f"\n--- Rewrite ({request.style}) --- model={REWRITE_MODEL} len={len(body)}")

    try:
        instruction = STYLE_INSTRUCTIONS[request.style]
        llm = get_llm(
            api_key,
            REWRITE_MODEL,
            max_tokens=4096,
            temperature=0.35,
        )
        chain = build_rewrite_template(instruction) | llm | StrOutputParser()
        result = await chain.ainvoke({"text": body})
        result = normalize_rewrite_output(result)
        print(f"Rewrite done, out_len={len(result)}\n")

        if not result:
            raise HTTPException(status_code=500, detail="Model returned empty rewrite.")

        return RewriteResponse(text=result)

    except HTTPException:
        raise
    except Exception as e:
        print(f"Rewrite error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
