from openai import OpenAI

# .\.venv\Scripts\Activate.ps1
# 使用 Portkey 网关初始化 OpenAI SDK
client = OpenAI(
    api_key="pk-local-32622da9596a42dca3066c9a449bf58e",
    base_url="http://localhost:8787"
)

response = client.chat.completions.create(
    model="openrouter/openrouter-hunter-alpha",
    messages=[{"role": "user", "content": "What is a fractal?"}]
)

print(response.choices[0].message.content)
