import os
import sys
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

# Layer 3: Deterministic Execution
# This script handles data storage to Supabase.

def get_supabase_client():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    
    if not url or not key:
        print("Error: Supabase credentials not found in environment.", file=sys.stderr)
        return None
        
    return create_client(url, key)

def save_crawled_data(table_name, data):
    supabase = get_supabase_client()
    if not supabase:
        return False
        
    try:
        # Returning count ensures we know something happened, though upsert might return different things based on provider
        response = supabase.table(table_name).upsert(data, on_conflict='url').execute()
        return True
    except Exception as e:
        print(f"Error saving to Supabase: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    # Test connection
    client = get_supabase_client()
    if client:
        print("Supabase connection successful.")
    else:
        print("Supabase connection failed.")
