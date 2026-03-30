import json
from pathlib import Path

from openai import OpenAI


config_path = Path(__file__).resolve().parents[1] / ".portkey" / "local-gateway.config.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
gateway_key = config["gatewayKeys"][0]

# .\.venv\Scripts\Activate.ps1
# 使用 Portkey 网关初始化 OpenAI SDK
client = OpenAI(api_key=gateway_key, base_url="http://localhost:18788")

response = client.chat.completions.create(
    model="LongCat-Flash-Lite",
    messages=[
        {
            "role": "user",
            "content": "在/file文件夹下创建一个新文件test.txt，并写入内容'Hello, Portkey!'",
        }
    ],
)

print(response.choices[0].message.content)
