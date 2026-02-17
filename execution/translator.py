import os
import sys
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

# Layer 3: Deterministic Execution
# Service: Google Gemini API for Translation

def get_gemini_model():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("Error: GEMINI_API_KEY not found.", file=sys.stderr)
        return None
        
    genai.configure(api_key=api_key)
    return genai.GenerativeModel('gemini-2.0-flash')

def translate_text(text, target_lang="Korean"):
    if not text:
        return ""
        
    model = get_gemini_model()
    if not model:
        return text # Fail gracefully by returning original
        
    try:
        # Prompt Engineering for better translation
        prompt = f"""You are a professional IT translator.
Translate the following text into natural, business-casual {target_lang}.
Maintain technical terms if they are commonly used in the industry (e.g., SaaS, IPO).

Rules:
- Output ONLY the translated text. No alternatives, no explanations, no markdown formatting.
- Do not add any prefix like "Translation:" or "Here is the translation".
- Preserve the original paragraph structure.

Text:
{text}"""
        
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"Translation Error: {e}", file=sys.stderr)
        return text

if __name__ == "__main__":
    # Test
    test_text = "Y Combinator creates a new deal for startups."
    print(f"Original: {test_text}")
    print(f"Translated: {translate_text(test_text)}")
