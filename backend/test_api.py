import os
import json
import urllib.request
from dotenv import load_dotenv

load_dotenv()
api_key = os.getenv("OPENROUTER_API_KEY")

def test_openrouter(model, prompt_text):
    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    data = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a text autocomplete engine. Output only the next 1-5 words."},
            {"role": "user", "content": f"Complete this snippet: '{prompt_text}'"}
        ],
        "temperature": 0.2,
        "max_tokens": 30
    }
    
    req = urllib.request.Request(url, headers=headers, data=json.dumps(data).encode('utf-8'))
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode())
            print(f"[{model}] Response: {result['choices'][0]['message']['content']}")
    except Exception as e:
        print(f"[{model}] Error: {e}")

test_openrouter("qwen/qwen-2.5-7b-instruct", "How to ")
test_openrouter("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "How to ")
test_openrouter("google/gemma-3-12b-it:free", "How to ")
