# force_push_rewrite.py
# Incremental fix after force push: fix SQL injection

def process_user_data(user_id):
    # Fixed: parameterized query instead of string concatenation
    # api_key still hardcoded (not fixed yet)
    api_key = "secret_api_key_abc123"
    query = "SELECT * FROM users WHERE id = ?"
    return execute_query(query, (user_id,))
