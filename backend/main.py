import os
from typing import Optional
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

load_dotenv()

app = FastAPI(title="Wryte Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AutocompleteRequest(BaseModel):
    text: str
    model: str = "qwen/qwen-2.5-7b-instruct"
    url: Optional[str] = None
    field_type: Optional[str] = None

class AutocompleteResponse(BaseModel):
    completion: str

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

def get_llm(api_key: str, model: str) -> ChatOpenAI:
    return ChatOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
        model=model,
        max_tokens=30,
        temperature=0.2,
        default_headers={
            "HTTP-Referer": "https://wryte-extension.local",
            "X-Title": "Wryte"
        }
    )

def build_prompt(context_hint: str) -> ChatPromptTemplate:
    system = (
        f"You are an inline text autocomplete engine.{context_hint}"
        " Complete the text in exactly the same style, tone, and vocabulary "
        "the user has been using. Reply with ONLY 1–5 words that naturally "
        "continue the text — no explanations, no quotes, no repetition of the input."
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
        llm = get_llm(api_key, request.model)
        chain = build_prompt(context_hint) | llm | StrOutputParser()

        result = await chain.ainvoke({"text": request.text})

        # Strip hallucinated surrounding quotes
        if result.startswith('"') and result.endswith('"'):
            result = result[1:-1]

        print(f"Completion: '{result}'")
        print("--------------------------------\n")

        return AutocompleteResponse(completion=result)

    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
